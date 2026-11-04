import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as AnyConnect from '../src/index.js'
import { signedInDocument } from './catalog-harness.js'
import { WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from '../src/status-paths.js'

/**
 * REAL-composition 回归（RULE-080）：经真实的 `cordis-plugin-loader` 装载入口，
 * 而不是测试里手搓 `ctx.plugin(...)`。
 *
 * 真实装配面：
 * - 真实 `Loader`（entry tree / 生命周期 / 服务注入 / 卸载顺序都走宿主同一实现）；
 * - 真实 `dsh-llm` 的 `LlmRuntime`（provider 注册表）；
 * - 真实 `dsh-host-webserver` 的 `WebServer`（真实 127.0.0.1:0 listener，真的收发 HTTP）；
 * - 本包入口（含 `Config` schema 由 Loader 解析、`inject: ['llm']` 服务等待）。
 *
 * 只 mock 两处（其余全真）：
 * 1. 上游 HTTP：`vi.stubGlobal('fetch', …)` 统一答 500（不触真实网络）；
 * 2. 桌面凭据：临时目录写一份「看起来已登录」的 WorkBuddy 桌面凭据文件
 *    （测试框架已把 DSH_HOME 隔离到全新空目录）。
 *
 * 未装配的宿主服务（阻塞点如实记录）：
 * - `dsh-settings` 的 `SettingsForms` 声明 `inject = ['configEditor','profileContext']`，
 *   这些是宿主 profile 基础设施，本包 devDependencies 里没有、也不该为一个测试
 *   拖进整个 profile 栈。缺席时本包走的是**真实降级路径**（`ctx.inject` 不触发，
 *   settings.configure 不执行），不影响模型通道；配置面由包内 bundle 配置卡片承载。
 * - `storageDomain` 同理（可选服务；缺席时凭据读写走文件回落，本包生产代码已
 *   显式支持）。
 * - `cordis-plugin-include`（YAML `cordis.yml` 解析插件）未在本包 devDependencies
 *   里，因此这里不做 YAML 文件装载，改用 Loader 自己的 entry-tree API
 *   （`loader.create` + `loader.internal.import`）构建同样的组合——这正是 Include
 *   解析 YAML 之后走的那条路径，入口/服务/生命周期完全一致。
 */

const PROVIDER_IDS = ['workbuddy', 'workbuddy-ai', 'zcode', 'zcode-start-plan', 'opencode-free'] as const

/**
 * 只 mock **上游** HTTP：真实 fetch 留给 127.0.0.1 上的真实 WebServer（本测试
 * 自己也要经 HTTP 访问插件路由），其余（上游域名）统一答 500，不触真实网络。
 */
function stubUpstreamFetch(): void {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/u.test(url)) {
      return await realFetch(input, init)
    }
    return new Response(JSON.stringify({ code: 500, msg: 'stub upstream' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = undefined
})

/** 组合里挂的 fixture：一个结构上够用的 providerUsage registry，用来观测注册/回收。 */
interface UsageFixture {
  registrations: Map<string, () => void>
}

interface Composition {
  ctx: Context
  origin: () => string
  anyConnectEntryId: string
  usage: UsageFixture
  /** 组合内的状态查询助手：当前 llm provider id 列表。 */
  providers: () => string[]
}

/**
 * 用 Loader 的 entry-tree API 装配最小真实组合（等价于 Include 解析 YAML 后的
 * 结果；见模块头的阻塞点说明）。返回可观测句柄。
 */
async function composeComposition(desktopFile: string): Promise<Composition> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(Loader)
  ctx.baseUrl = `${pathToFileURL(root!).href}/`

  const usage: UsageFixture = { registrations: new Map() }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@chaoset/dsh-any-connect', AnyConnect],
    ['fixture-provider-usage', {
      name: 'fixture-provider-usage',
      apply(fixtureCtx: Context) {
        // 结构最小 registry：本包只调 register(provider, querier, displayName)，
        // 返回值是 disposer；用它就能观测「注册被回收」。
        fixtureCtx.provide('providerUsage', {
          register(provider: string) {
            const dispose = (): void => { usage.registrations.delete(provider) }
            usage.registrations.set(provider, dispose)
            return dispose
          },
        } as never)
      },
    }],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>

  await ctx.loader.create({ name: 'fixture-provider-usage' })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } })
  await ctx.loader.create({ name: '@deepseek-ai/dsh-llm' })
  const anyConnectEntryId = await ctx.loader.create({
    name: '@chaoset/dsh-any-connect',
    // Loader 会用本包入口导出的 Config schema 解析这份部分配置：其余字段走
    // schema 默认值（空串）。这也顺带验证了「patch/loader 只给部分字段」的真实路径。
    config: { authFile: desktopFile, authFileAI: join(root!, 'no-such-ai-file.info') },
  })
  await ctx.loader.await()

  return {
    ctx,
    origin: () => ctx.webServer.getOrigin(),
    anyConnectEntryId,
    usage,
    providers: () => ctx.llm.listProviders().map(provider => provider.id),
  }
}

/** 等组合进入「已注册 5 条路由 + 适配器就绪」的稳定态。 */
async function awaitLive(composition: Composition): Promise<void> {
  await vi.waitFor(() => {
    expect(composition.providers().slice().sort(), '5 个 provider 都应注册').toEqual([...PROVIDER_IDS].sort())
  }, { timeout: 15_000 })
}

/** 本包的入口 entry（含 fiber 状态/卸载 pledge，用于断言 ACTIVE 与 HMR）。 */
function anyConnectEntry(composition: Composition): Entry {
  for (const entry of composition.ctx.loader.entries()) {
    if (entry.options.name === '@chaoset/dsh-any-connect') return entry
  }
  throw new Error('any-connect entry not found in loader tree')
}

/** 一个同源浏览器请求（Host 由 fetch 自动给出，Origin/Sec-Fetch-Site 显式构造）。 */
function sameOriginHeaders(origin: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    ...extra,
  }
}

describe('REAL Loader composition', () => {
  it('装载真实组合：插件 ACTIVE、5 条 provider、status/probe 路由真实可响应', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-loader-'))
    const desktopFile = join(root, 'workbuddy-desktop.info')
    await writeFile(desktopFile, signedInDocument())
    // 只 mock 上游 HTTP（本机回环留给真实 WebServer，见 stubUpstreamFetch）。
    stubUpstreamFetch()

    const composition = await composeComposition(desktopFile)
    await awaitLive(composition)

    // 1) 插件 ACTIVE：Loader entry 的 fiber 处于 FiberState.ACTIVE(2)
    //（FiberState 是 const enum，运行时被擦除，只能按宿主 d.ts 的数值断言）。
    const entry = anyConnectEntry(composition)
    expect(entry.fiber?.state, 'Loader 的入口 fiber 应为 ACTIVE').toBe(2)

    // 2) llm provider 注册表：5 条真实路由
    expect(composition.providers().slice().sort()).toEqual([...PROVIDER_IDS].sort())

    // 3) status 路由走真实 WebServer：同源 GET 返回已登录文档 + 写路由门槛 key
    const origin = composition.origin()
    const statusResponse = await fetch(origin + WORKBUDDY_STATUS_PATH, {
      headers: sameOriginHeaders(origin),
    })
    if (statusResponse.status !== 200) throw new Error(`status route failed: ${await statusResponse.text()}`)
    expect(statusResponse.status).toBe(200)
    const status = await statusResponse.json() as { status?: string; probeKey?: string }
    expect(status.status).toBe('signed-in')
    expect(typeof status.probeKey, '同源请求应拿到 probeKey').toBe('string')

    // 4) probe 路由：带同源 Origin + key 的 POST 被真实分发（refresh 返回 ok，
    //    目录刷新本身是后台链路，不需要等它落定）。
    const probeResponse = await fetch(origin + WORKBUDDY_PROBE_PATH, {
      method: 'POST',
      headers: sameOriginHeaders(origin, {
        'content-type': 'application/json',
        'x-workbuddy-probe-key': status.probeKey!,
      }),
      body: JSON.stringify({ action: 'refresh' }),
    })
    expect(probeResponse.status).toBe(200)
    expect(await probeResponse.json()).toEqual({ state: 'ok' })

    // 5) 反向：环回但不同端口的 Origin 到真实写路由必须 403（AC-11 的端到端面）。
    const foreign = await fetch(origin + WORKBUDDY_PROBE_PATH, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.1:9',
        'content-type': 'application/json',
        'x-workbuddy-probe-key': status.probeKey!,
      },
      body: JSON.stringify({ action: 'refresh' }),
    })
    expect(foreign.status).toBe(403)

    // 6) provider-usage seam：5 个变体各注册一条查询器（真实引用传递走完）
    expect(composition.usage.registrations.size).toBe(5)
  }, 30_000)

  it('HMR dispose→移除：路由 / adapter / usage querier 三条注册面全部回滚', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-loader-hmr-'))
    const desktopFile = join(root, 'workbuddy-desktop.info')
    await writeFile(desktopFile, signedInDocument())
    stubUpstreamFetch()

    const composition = await composeComposition(desktopFile)
    await awaitLive(composition)
    const origin = composition.origin()
    expect(composition.usage.registrations.size).toBe(5)

    // HMR：卸载入口 entry（等价于宿主卸载/重载插件）。Loader.remove 对
    // fiber.dispose() 是 fire-and-forget（宿主 loader 的 remove 不 await），
    // 这里显式等插件 fiber 的卸载 pledge——这正是宿主卸载/重载时会等的那一步。
    const entry = anyConnectEntry(composition)
    const disposing = entry.fiber?.dispose()
    composition.ctx.loader.remove(composition.anyConnectEntryId)
    await disposing
    await composition.ctx.loader.await()

    // 1) adapter 回滚：llm 注册表不再含本包 5 条路由
    expect(composition.providers(), '卸载后 adapter 注册必须回滚').toEqual([])

    // 2) usage querier 回滚：每个变体的查询器 disposer 被调用
    expect(composition.usage.registrations.size, '卸载后 usage 查询器必须注销').toBe(0)

    // 3) 路由回滚：status / probe 两条真实路由都不再响应 200
    const statusAfter = await fetch(origin + WORKBUDDY_STATUS_PATH, { headers: sameOriginHeaders(origin) })
    expect(statusAfter.status, '卸载后 status 路由必须移除').toBe(404)
    const probeAfter = await fetch(origin + WORKBUDDY_PROBE_PATH, {
      method: 'POST',
      headers: sameOriginHeaders(origin, { 'content-type': 'application/json' }),
      body: JSON.stringify({ action: 'refresh' }),
    })
    expect(probeAfter.status, '卸载后 probe 路由必须移除').toBe(404)

    // 4) 干净重载：同一组合里重新创建 entry 能成功（无重复注册残留）——
    //    webServer 路由表重复 path 会抛错，adapter 重复注册也会抛；能重载即证明
    //    前一次卸载把注册面真的清干净了。
    await composition.ctx.loader.create({
      name: '@chaoset/dsh-any-connect',
      config: { authFile: desktopFile, authFileAI: join(root!, 'no-such-ai-file.info') },
    })
    await composition.ctx.loader.await()
    await awaitLive(composition)
    expect(composition.usage.registrations.size, '重载后 usage 查询器重新注册').toBe(5)
  }, 45_000)
})
