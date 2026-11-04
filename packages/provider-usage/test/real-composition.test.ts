// @vitest-environment node
/**
 * REAL-composition 回归（RULE-080 / docs/testing.md「Test the real entry path」）：
 *
 * 用**真实** Loader + 真实 `@deepseek-ai/dsh-host-webserver`（真 127.0.0.1:0
 * listener）+ 真实 `@deepseek-ai/dsh-llm` + 真实 `@deepseek-ai/dsh-commands`
 * 装载本包的**构建产物** `lib/index.js`，然后走一次真实 HTTP 请求，覆盖单元测试
 * 摸不到的装配面：
 *
 * - Loader 的 export 归一化与 entry 生命周期（dispose 后路由真的消失 → 404）；
 * - 本包 `inject: []` + `ctx.get` 的可选服务策略在真实宿主服务栈下的行为；
 * - route 的真实 HTTP 层（Host/Origin 回环守卫、JSON 序列化、cacheTtlMs 贯通）；
 * - `ctx.providerUsage` 扩展点在真实服务上的注册/反注册；
 * - `/usage` 命令真的注册进真实 `commands` 服务。
 *
 * 依赖构建产物 `lib/index.js`（`bun run test` 会先构建；单独跑本文件前需先
 * `node ../../scripts/build.mjs` 或 `tsc -p packages/provider-usage/tsconfig.json`）。
 * 缺产物时**显式失败**并给出构建命令，不静默跳过——这就是发布产物的真实装配路径。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import LlmRuntime from '@deepseek-ai/dsh-llm'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_ENTRY = join(PACKAGE_ROOT, 'lib', 'index.js')

/** 构建产物是否可用；缺失时给出可执行的补救命令。 */
function requireBuiltEntry(): string {
  if (!existsSync(LIB_ENTRY)) {
    throw new Error(
      `REAL-composition 需要本包构建产物 ${LIB_ENTRY}。`
      + ' 先运行 `node ../../scripts/build.mjs`（或本包 `tsc -p tsconfig.json`）再跑测试。',
    )
  }
  return pathToFileURL(LIB_ENTRY).href
}

interface Composition {
  readonly ctx: Context
  readonly loader: Loader
  readonly entryId: string
  readonly origin: string
}

/**
 * 装配真实宿主：真实 Loader + 真实 webServer/llm/commands + 本包产物 entry。
 *
 * 注意 Loader 必须在其它插件之前创建：Loader 通过 `_patchContext` 给 entry
 * 派生 context，在已被其它插件改写过的根 context 上创建会抛
 * `Cyclic __proto__ value`（实测于 cordis-plugin-loader 1.1.0）。
 *
 * @param config - 传给本包入口的 Loader config（默认 cacheTtlMs 1234 以验证贯通）。
 * @returns 装配好的 context/loader/entry 与真实 listener origin。
 */
async function compose(config: Record<string, unknown> = { cacheTtlMs: 1_234 }): Promise<Composition> {
  const entryName = requireBuiltEntry()
  const ctx = new Context()
  const loader = new Loader(ctx, { baseUrl: pathToFileURL(PACKAGE_ROOT + '/').href })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  // id 由 Loader 生成（EntryTree.create 的入参类型不含 id），用返回值移除 entry。
  const entryId = await loader.create({ name: entryName, config })
  await loader.await()
  const origin = ctx.webServer.getOrigin()
  return { ctx, loader, entryId, origin }
}

/**
 * 拆除真实装配：先卸 entry，再关整个 fiber（含 HTTP listener）。
 *
 * 用例可能已经自己 remove 过 entry（dispose→404 用例）：此时 Loader 里已没有
 * 该 id，`remove` 会抛 `cannot resolve entry`，吞掉即可——拆除必须幂等，失败
 * 路径上的清理不能反过来变成新的红灯。
 */
async function dispose(composition: Composition | undefined): Promise<void> {
  if (composition === undefined) return
  try {
    composition.loader.remove(composition.entryId)
  } catch {
    // 已由用例卸载：Loader 里不再有该 entry。
  }
  await composition.loader.await()
  await composition.ctx.fiber.dispose()
}

describe('REAL-composition：真实 Loader + webServer + llm + 本包产物', () => {
  it('真实 HTTP 读取扩展点注册的 provider，并带回 Config.cacheTtlMs', async () => {
    let composition: Composition | undefined
    try {
      composition = await compose()
      const { ctx, origin } = composition

      // 真实服务栈就位：本包 inject=[] 仍能工作，说明可选服务策略成立。
      expect(ctx.llm, '真实 dsh-llm 已装配').toBeDefined()
      expect(ctx.commands, '真实 dsh-commands 已装配').toBeDefined()
      expect(ctx.providerUsage, '/usage 服务随 entry 激活').toBeDefined()
      // 内置 querier 全部注册（11 条路由由 providers.ts 决定）。
      expect(ctx.providerUsage.providers().length).toBe(11)
      // `/usage` 命令注册进真实 commands 服务。
      expect(ctx.commands.find(undefined as never, 'usage')?.name).toBe('usage')

      // 公开扩展点：第三方向真实 registry 注册 querier。
      const disposeQuerier = ctx.providerUsage.register(
        'acme',
        async ({ provider }) => ({
          provider,
          windows: [{ id: 'w', label: 'W', unit: 'credits', remain: 5 }],
          fetchedAt: Date.now(),
        }),
        'Acme',
      )

      const response = await fetch(new URL('/plugins/provider-usage/usage?providers=acme', origin))
      expect(response.status).toBe(200)
      const body = await response.json() as {
        cacheTtlMs: number
        snapshots: Array<Record<string, unknown>>
      }
      // Config → registry → route JSON 的 TTL 贯通：client 用它排下一次轮询。
      expect(body.cacheTtlMs).toBe(1_234)
      expect(body.snapshots).toHaveLength(1)
      expect(body.snapshots[0]).toMatchObject({
        provider: 'acme',
        displayName: 'Acme',
        windows: [{ id: 'w', label: 'W', unit: 'credits', remain: 5 }],
      })
      expect(typeof body.snapshots[0]!['fetchedAt']).toBe('number')

      // 反注册后同一路由返回「无 querier」标记，而不是 404（route 契约）。
      disposeQuerier()
      const after = await fetch(new URL('/plugins/provider-usage/usage?providers=acme', origin))
      expect(after.status).toBe(200)
      expect(await after.json()).toMatchObject({ snapshots: [{ provider: 'acme', queried: false }] })
    } finally {
      await dispose(composition)
    }
  })

  it('entry dispose 后真实 HTTP 路由 404、服务面消失（HMR/卸载安全）', async () => {
    let composition: Composition | undefined
    try {
      composition = await compose()
      const { ctx, loader, entryId, origin } = composition
      expect((await fetch(new URL('/plugins/provider-usage/usage?providers=acme', origin))).status).toBe(200)

      loader.remove(entryId)
      await loader.await()

      // 路由随 entry 的 effect 一起反注册；webServer 的 fallback 没有注册者 → 404。
      const after = await fetch(new URL('/plugins/provider-usage/usage?providers=acme', origin))
      expect(after.status).toBe(404)
      // 服务随 fiber 卸载消失（严格 get，不抛错的那一形态）。
      expect(ctx.get('providerUsage')).toBeUndefined()
      // 宿主服务本身不受影响：卸载的只是本插件。
      expect(ctx.llm).toBeDefined()
    } finally {
      await dispose(composition)
    }
  })
})
