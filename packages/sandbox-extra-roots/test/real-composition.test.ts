import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import * as pluginModule from '../src/index.js'
import { canon } from '../src/roots.js'

/**
 * 最小 REAL-composition（RULE-080）：经**真实 Loader** 加载本插件入口，
 * 与真实的官方 `SandboxPolicyService` 组合（不是手写 ctx.plugin 桩），验证
 * 「配置根 → 官方 policy → 官方 writableRoots(enforcement 唯一来源）」整条链路，
 * 以及 Loader 卸载 entry 后官方 resolve 被还原。
 *
 * 只 stub 了 SandboxPolicyService 的 `sessionProjections` 依赖（注册会话投影
 * 单元，与本插件无关）；policy 的 resolve 是官方真实实现。
 */

let context: Context | undefined
const made: string[] = []

function tempDir(prefix: string): string {
  const dir = canon(mkdtempSync(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 组装真实组合：官方 policy service + 官方 Loader（模块导入走测试注入表）。 */
async function compose(): Promise<Context> {
  const ctx = new Context()
  // SandboxPolicyService 的静态 inject 需要 sessionProjections 服务；这里给
  // 最小 stub（真实 registry 只需 register 返回可 stateOf 的 handle，本插件
  // 不消费会话状态）。
  ctx.provide('sessionProjections', {
    async register() {
      return { stateOf: () => null }
    },
  } as never)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/ws' })
  await ctx.plugin(Loader)
  // Loader 的模块导入缝：把包名映射到本仓 src 入口（真实插件模块常量导出）。
  const modules = new Map<string, unknown>([['@chaoset/sandbox-extra-roots', pluginModule]])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const mod = modules.get(specifier)
      if (mod === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return mod
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  return ctx
}

describe('REAL-composition（官方 Loader + 官方 sandbox-policy）', () => {
  it('经 Loader 加载后，配置根出现在官方 policy 并被 writableRoots 消费；卸载后还原', async () => {
    const extra = tempDir('ser-real-extra-')
    context = await compose()
    const ctx = context

    // 官方 enforcement 的唯一来源（Seatbelt/bwrap/Landlock/fs fence 共用）。
    expect(writableRoots(ctx.sandboxPolicy.resolve())).not.toContain(extra)

    const id = await ctx.loader.create({
      name: '@chaoset/sandbox-extra-roots',
      config: { extraWritableRoots: [extra] },
    })
    await ctx.loader.await()

    const resolved = ctx.sandboxPolicy.resolve()
    expect(resolved.mode).toBe('workspace-write')
    expect(resolved.additionalWritableRoots).toContain(extra)
    expect(writableRoots(resolved)).toContain(extra)

    // 卸载 entry：包装引用计数归零，官方 resolve 还原（不再授予额外根）。
    ctx.loader.remove(id)
    await ctx.loader.await()
    expect(ctx.sandboxPolicy.resolve().additionalWritableRoots).toBeUndefined()
    expect(writableRoots(ctx.sandboxPolicy.resolve())).not.toContain(extra)
  })

  it('经真实 Config schema 校验：非法 extraWritableRoots 在加载期 fail loud', async () => {
    context = await compose()
    const ctx = context
    const id = await ctx.loader.create({
      name: '@chaoset/sandbox-extra-roots',
      config: { extraWritableRoots: 'not-an-array' },
    })
    await ctx.loader.await()
    // Loader 的 entry 初始化不把校验错误抛给 create()：错误由 entry fiber
    // 承载（await() 拒绝），插件不会激活，也不会有任何根被并入。
    const entry = ctx.loader.resolve(id)
    await expect(entry.fiber!.await()).rejects.toThrow(/extraWritableRoots/)
    expect(ctx.get('sandboxExtraRootsConfig')).toBeUndefined()
    expect(ctx.sandboxPolicy.resolve().additionalWritableRoots).toBeUndefined()
  })
})
