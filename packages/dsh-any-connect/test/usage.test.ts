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
      expect(registry.registered.map(entry => entry.provider).sort()).toEqual(['workbuddy', 'workbuddy-ai', 'zcode'])
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
