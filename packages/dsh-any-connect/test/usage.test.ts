/**
 * The WorkBuddy usage querier this plugin registers against the optional
 * `providerUsage` registry.
 *
 * The provider-usage package ships no WorkBuddy querier on purpose — only this
 * package can read that desktop app's credential — so this is where the
 * "every provider" claim is actually delivered for the route users run.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.js'

/** One registered querier, captured by the stub registry below. */
interface Registration {
  provider: string
  displayName: string | undefined
  query: (context: { provider: string; signal?: AbortSignal }) => Promise<{
    provider: string
    windows: readonly { id: string; label: string; remain?: number; limit?: number; unit: string }[]
    displayName?: string
  }>
}

// unique symbol 类型要求 const 声明：类静态属性的计算键不能用内联 Symbol.for。
const CORDIS_SERVICE = Symbol.for('cordis.service')

/**
 * A stand-in for @chaoset/provider-usage's registry.
 *
 * This package deliberately does not depend on that package (they install
 * independently), so the test supplies the same structural surface the real
 * service exposes and calls the captured querier directly.
 */
class StubUsageRegistry {
  static readonly [CORDIS_SERVICE] = true
  readonly registered: Registration[] = []

  register(provider: string, querier: Registration['query'], displayName?: string): () => void {
    this.registered.push({ provider, displayName, query: querier })
    return () => {
      const index = this.registered.findIndex(entry => entry.provider === provider)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }
}

/** A credential document shaped like the desktop app's own auth file. */
function authDocument(): string {
  return JSON.stringify({
    auth: {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.now() + 3_600_000,
      domain: 'www.workbuddy.cn',
    },
    account: { uid: 'uid-1', nickname: 'tester' },
  })
}

/** The same document for the international app, which rejects a CN domain. */
function authDocumentGlobal(): string {
  return JSON.stringify({
    auth: {
      accessToken: 'at-ai',
      refreshToken: 'rt-ai',
      expiresAt: Date.now() + 3_600_000,
      domain: 'www.workbuddy.ai',
    },
    account: { uid: 'uid-ai', nickname: 'tester-ai' },
  })
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Boot the plugin with a stub usage registry mounted alongside it. */
async function boot(options: { signedIn: boolean }): Promise<{ registry: StubUsageRegistry; authFile: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-usage-'))
  vi.stubEnv('DSH_HOME', root)
  const authFile = join(root, 'workbuddy-desktop.info')
  await writeFile(authFile, options.signedIn ? authDocument() : JSON.stringify({ auth: {} }))
  // The international variant reads its own file; without it the AI querier
  // would fail credential resolution rather than report a balance.
  const aiAuthFile = join(root, 'workbuddy-desktop-ai.info')
  await writeFile(aiAuthFile, options.signedIn ? authDocumentGlobal() : JSON.stringify({ auth: {} }))

  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  const registry = new StubUsageRegistry()
  // Mount the stand-in as the `providerUsage` service the plugin waits for.
  // `provide` (not `set`) is the seam that makes the name visible to
  // `ctx.inject`/`ctx.get`, which is how the plugin reaches it.
  ctx.provide('providerUsage', registry)
  await ctx.plugin(WorkBuddy, { authFile, authFileAI: aiAuthFile })
  return { registry, authFile }
}

/** The billing response shape the upstream meter endpoint returns. */
function billingBody(accounts: readonly Record<string, unknown>[]): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: 'OK',
    data: { Response: { Data: { Accounts: accounts } } },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('WorkBuddy usage querier', () => {
  it('registers a querier for each variant it serves', async () => {
    const { registry } = await boot({ signedIn: false })
    await vi.waitFor(() => {
      expect(registry.registered.map(entry => entry.provider).sort()).toEqual(['workbuddy', 'workbuddy-ai', 'zcode', 'zcode-start-plan'])
    })
    expect(registry.registered.find(entry => entry.provider === 'workbuddy')?.displayName).toBe('WorkBuddy')
    expect(registry.registered.find(entry => entry.provider === 'zcode')?.displayName).toBe('ZCode')
  })

  it('reports a single total window summing live packages', async () => {
    const { registry } = await boot({ signedIn: true })
    await vi.waitFor(() => { expect(registry.registered.length).toBeGreaterThan(0) })

    vi.stubGlobal('fetch', vi.fn(async () => billingBody([
      { PackageName: 'Monthly', CycleCapacitySize: 100, CycleCapacityRemain: 24, CapacityRemain: 24, RemainCycles: 0, Status: 0 },
      // Drained and expired grants: a real account accumulates dozens, and
      // counting them would inflate the total with dead credit.
      { PackageName: 'Old grant', CycleCapacitySize: 500, CycleCapacityRemain: 0, CapacityRemain: 0, RemainCycles: 0, Status: 3 },
      { PackageName: 'Untouched', CycleCapacitySize: 5, CycleCapacityRemain: 5, CapacityRemain: 5, RemainCycles: 1, Status: 0 },
    ])))

    const entry = registry.registered.find(candidate => candidate.provider === 'workbuddy')!
    const snapshot = await entry.query({ provider: 'workbuddy' })
    // 24 + (5 + 1×5): the untouched package counts its future cycle, the
    // drained grant counts for nothing; denominators summed for the bar.
    expect(snapshot.windows).toEqual([
      { id: 'total', label: '总计', remain: 34, unit: 'credits', limit: 110 },
    ])
  })

  it('reports an empty window list when every package is drained', async () => {
    const { registry } = await boot({ signedIn: true })
    await vi.waitFor(() => { expect(registry.registered.length).toBeGreaterThan(0) })
    vi.stubGlobal('fetch', vi.fn(async () => billingBody([
      { PackageName: 'Spent', CycleCapacitySize: 10, CycleCapacityRemain: 0, CapacityRemain: 0, RemainCycles: 0, Status: 0 },
    ])))

    const entry = registry.registered.find(candidate => candidate.provider === 'workbuddy')!
    expect((await entry.query({ provider: 'workbuddy' })).windows).toEqual([])
  })

  it('propagates a billing failure so the registry records it', async () => {
    const { registry } = await boot({ signedIn: true })
    await vi.waitFor(() => { expect(registry.registered.length).toBeGreaterThan(0) })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))

    const entry = registry.registered.find(candidate => candidate.provider === 'workbuddy')!
    // The registry owns the failure posture (keep last good windows, annotate
    // the error); the querier's job is to not swallow it.
    // 断言错误内容(上游 500 状态码出现在消息里)而非仅「reject 了」:
    // querier 内部的意外 TypeError 不能与受控的计费失败混同过关。
    await expect(entry.query({ provider: 'workbuddy' })).rejects.toThrow(/500/)
  })

  it('omits the limit when no package reports a size', async () => {
    const { registry } = await boot({ signedIn: true })
    await vi.waitFor(() => { expect(registry.registered.length).toBeGreaterThan(0) })
    vi.stubGlobal('fetch', vi.fn(async () => billingBody([
      { PackageName: 'NoSize', CycleCapacityRemain: 3, CapacityRemain: 3, RemainCycles: 0, Status: 0 },
    ])))

    const entry = registry.registered.find(candidate => candidate.provider === 'workbuddy')!
    const snapshot = await entry.query({ provider: 'workbuddy' })
    expect(snapshot.windows).toEqual([
      { id: 'total', label: '总计', remain: 3, unit: 'credits' },
    ])
  })

describe('totalCreditsWindows / currentPlanWindow', () => {
  it('sums live packages, skips drained ones, empties when all drained', () => {
    expect(WorkBuddy.totalCreditsWindows([])).toEqual([])
    expect(WorkBuddy.totalCreditsWindows([
      { packageName: 'A', remain: 0, size: 100 },
    ])).toEqual([])
    expect(WorkBuddy.totalCreditsWindows([
      { packageName: 'A', remain: 24, size: 100 },
      { packageName: 'B', remain: 0, size: 500 },
      { packageName: 'C', remain: 10, size: 0 },
    ])).toEqual([{ id: 'total', label: '总计', remain: 34, unit: 'credits', limit: 100 }])
  })

  it('picks the first live plan, falling back to the first plan', () => {
    expect(WorkBuddy.currentPlanWindow([])).toEqual([])
    expect(WorkBuddy.currentPlanWindow([
      { packageName: 'Dead (已过期)', remain: 0, size: 1 },
      { packageName: 'Pro (有效)', remain: 1, size: 1, expiredAt: '2026-10-21T00:00:00.000Z' },
    ])).toEqual([{ id: 'plan', label: 'Pro', unit: '有效', resetsAt: '2026-10-21T00:00:00.000Z' }])
    expect(WorkBuddy.currentPlanWindow([
      { packageName: 'Only (VALID)', remain: 0, size: 1 },
    ])).toEqual([{ id: 'plan', label: 'Only', unit: '有效' }])
  })

  it('Start Plan 的当日 token 池带真实数字,pill 才有剩余额度可显示', () => {
    // billing/balance 的实测形状(2026-10-06):remain/size 是真实 token 数,
    // sameDay: true。窗口缺 remain 时 pill 只渲染「套餐名: 有效」——数字被
    // 丢掉等于用户在聊天框下方看不到剩余额度。
    expect(WorkBuddy.currentPlanWindow([
      { packageName: 'GLM-5.3-Flash (有效)', planName: 'ZCode Trust Build', remain: 91_464_568, size: 100_000_000, sameDay: true, expiredAt: '2026-10-06T16:00:00.000Z' },
    ])).toEqual([{
      id: 'plan',
      label: 'GLM-5.3-Flash',
      remain: 91_464_568,
      limit: 100_000_000,
      unit: 'tokens',
      resetsAt: '2026-10-06T16:00:00.000Z',
    }])
    // 当日用完(remain=0):照样带数字——红色空条正是「今天用完了」的语义。
    expect(WorkBuddy.currentPlanWindow([
      { packageName: 'GLM-5.3-Flash (有效)', remain: 0, size: 100_000_000, sameDay: true },
    ])).toEqual([{ id: 'plan', label: 'GLM-5.3-Flash', remain: 0, limit: 100_000_000, unit: 'tokens' }])
    // size = 0(理论不应出现)防御:退回「有效」展示,避免 limit 0 的除零与无意义进度条。
    expect(WorkBuddy.currentPlanWindow([
      { packageName: 'Odd (有效)', remain: 5, size: 0, sameDay: true },
    ])).toEqual([{ id: 'plan', label: 'Odd', unit: '有效' }])
    // Coding Plan 订阅(无 sameDay,remain/size=1 的有效性标志)维持原样。
    expect(WorkBuddy.currentPlanWindow([
      { packageName: 'GLM Coding Pro (有效)', planName: 'GLM Coding Pro', remain: 1, size: 1 },
    ])).toEqual([{ id: 'plan', label: 'GLM Coding Pro', unit: '有效' }])
  })

  it('Start Plan 未领取时报「今日待领取」，而不是「不上报额度」', () => {
    // 每日 00:00 后新池子还没发放/领取：accounts 为空（billing/balance 如实返回
    // 空 balances）。pill 若落到通用的「该 provider 不上报额度」，用户会以为额度
    // 功能坏了——额度接口其实是通的，只是今天还没有池子。
    expect(WorkBuddy.startPlanWindows([])).toEqual([{ id: 'plan', label: 'Start Plan', unit: '今日待领取' }])
    // 有当日池子时仍然报真实 token 数（复用 currentPlanWindow 的 sameDay 口径）。
    expect(WorkBuddy.startPlanWindows([
      { packageName: 'GLM-5.3-Flash (有效)', remain: 90_000_000, size: 100_000_000, sameDay: true },
    ])).toEqual([{ id: 'plan', label: 'GLM-5.3-Flash', remain: 90_000_000, limit: 100_000_000, unit: 'tokens' }])
  })
})

it('reports the upstream plan name for ZCode instead of a hardcoded label', async () => {
    const { registry } = await boot({ signedIn: false })
    // ZCode reads its own credentials document; point it at a stub one. The
    // env var is read per resolution, so stubbing it after boot is the seam.
    const credPath = join(root!, 'zcode-credentials.json')
    await writeFile(credPath, JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'id.secret',
    }))
    vi.stubEnv('ZCODE_AUTH_FILE', credPath)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      data: [{ productName: 'ZCode Trust Build', status: 'VALID', expireTime: 1_790_697_600 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const entry = registry.registered.find(candidate => candidate.provider === 'zcode')!
    const snapshot = await entry.query({ provider: 'zcode' })
    // 上游的计划名随活动变化(本机实测 "ZCode Trust Build"),界面必须回填它,
    // 而不是写死 "Coding Plan" —— 那会把用户没有的套餐名报给用户。
    expect(snapshot.displayName).toBe('ZCode')
    expect((snapshot as { plan?: string }).plan).toBe('ZCode Trust Build')
    expect(snapshot.windows[0]?.label).toBe('ZCode Trust Build')
  })

  it('Coding Plan 的 pill 报 5 小时 / 7 天窗口（客户端同款 monitor 端点）', async () => {
    const { registry } = await boot({ signedIn: false })
    const credPath = join(root!, 'zcode-credentials.json')
    await writeFile(credPath, JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'id.secret',
    }))
    vi.stubEnv('ZCODE_AUTH_FILE', credPath)
    const quotaBody = {
      code: 200,
      data: {
        level: 'pro',
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10, nextResetTime: 1_791_403_544_725 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 24, nextResetTime: 1_791_865_446_983 },
        ],
      },
    }
    const subscriptionBody = {
      code: 200,
      data: [{ productName: 'GLM Coding Pro', status: 'VALID', expireTime: 1_790_697_600 }],
    }
    // 按 URL 分流：额度端点与订阅端点返回不同形状，避免「谁都能解析」的假绿。
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => new Response(JSON.stringify(
      String(url).includes('/api/monitor/usage/quota/limit') ? quotaBody : subscriptionBody,
    ), { status: 200, headers: { 'content-type': 'application/json' } })))

    const entry = registry.registered.find(candidate => candidate.provider === 'zcode')!
    const snapshot = await entry.query({ provider: 'zcode' })
    expect(snapshot.windows.map(window => window.label)).toEqual(['5 小时', '7 天'])
    // percentage 是已用：10% → 剩 90%；24% → 剩 76%。
    expect(snapshot.windows[0]).toMatchObject({ remain: 90, limit: 100, unit: '%' })
    expect(snapshot.windows[1]).toMatchObject({ remain: 76, limit: 100, unit: '%' })
    expect((snapshot as { plan?: string }).plan).toBe('GLM Coding Pro')
  })

  it('额度端点不可用 / 形状不符时回退订阅有效性窗口', async () => {
    const { registry } = await boot({ signedIn: false })
    const credPath = join(root!, 'zcode-credentials.json')
    await writeFile(credPath, JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'id.secret',
    }))
    vi.stubEnv('ZCODE_AUTH_FILE', credPath)
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/monitor/usage/quota/limit')) {
        return new Response('{"code":200,"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        code: 200,
        data: [{ productName: 'GLM Coding Pro', status: 'VALID', expireTime: 1_790_697_600 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const entry = registry.registered.find(candidate => candidate.provider === 'zcode')!
    const snapshot = await entry.query({ provider: 'zcode' })
    expect(snapshot.windows.map(window => window.label)).toEqual(['GLM Coding Pro'])
    expect(snapshot.windows[0]?.remain).toBeUndefined()
  })

  it('carries the variant display name through to the snapshot', async () => {
    const { registry } = await boot({ signedIn: true })
    await vi.waitFor(() => { expect(registry.registered.length).toBeGreaterThan(0) })
    vi.stubGlobal('fetch', vi.fn(async () => billingBody([
      { PackageName: 'AI pack', CapacityRemain: 8, CapacitySize: 30, Status: 0 },
    ])))

    const entry = registry.registered.find(candidate => candidate.provider === 'workbuddy-ai')!
    const snapshot = await entry.query({ provider: 'workbuddy-ai' })
    expect(snapshot.provider).toBe('workbuddy-ai')
    expect(snapshot.displayName).toBe('WorkBuddy AI')
  })
})
