import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerUsageQueriers } from '../src/usage.js'
import { RateLimitLedger, observeRateLimits } from '../src/rate-limit.js'
import type { VariantRuntime } from '../src/variant-runtime.js'
import type { WorkBuddyVariant } from '../src/variants.js'

/**
 * usage 查询器 → wire 的「逐模型限流」回归。
 *
 * 用户报的现象：换一个模型，之前那个被限流模型的限流信息就没了。根因是查询器
 * 只上报「最近一条活跃观测」（activeFor），切回先前模型时那条已经不在快照里。
 * 现在查询器上报台账里该 provider 的**全部**活跃观测（activesFor → rateLimits
 * 数组），切回先前模型时它的限流信息还在。
 *
 * 这里直接构造一份装了多个模型观测的台账，调用真实 registerUsageQueriers，
 * 断言捕获到的查询器把每一条都带过 wire。
 */

const CORDIS_SERVICE = Symbol.for('cordis.service')

/** 捕获注册进来的查询器（结构面桩）。 */
class CapturingRegistry {
  static readonly [CORDIS_SERVICE] = true
  readonly queriers = new Map<string, (context: { provider: string; signal?: AbortSignal }) => Promise<{
    provider: string
    windows: readonly unknown[]
    fetchedAt: number
    rateLimits?: readonly { model?: string; hits: number; status: number }[]
  }>>()

  register(provider: string, querier: (context: { provider: string; signal?: AbortSignal }) => Promise<never>): () => void {
    this.queriers.set(provider, querier as never)
    return () => { this.queriers.delete(provider) }
  }
}

/** 最小可用变体运行时：只为让查询器跑到「读台账」那一步。 */
function fakeRuntime(overrides: Partial<VariantRuntime> = {}): VariantRuntime {
  const variant = { id: 'workbuddy', kind: 'workbuddy', displayName: 'WorkBuddy' } as WorkBuddyVariant
  return {
    variant,
    store: { resolve: async () => ({}) },
    client: { fetchCredits: async () => ({ accounts: [], total: 0 }) },
    ledger: undefined,
    ...overrides,
  } as unknown as VariantRuntime
}

/** 造一条 429 观测（按模型）。 */
function observe(provider: string, model: string, nowMs: number) {
  return observeRateLimits({ provider, status: 429, kind: 'soft_rate', model, nowMs })[0]!
}

describe('usage 查询器：逐模型限流过 wire', () => {
  it('多个模型同时被限 → rateLimits 带上每一条', async () => {
    const ctx = new Context()
    const registry = new CapturingRegistry()
    ctx.provide('providerUsage', registry as never)
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record(observe('workbuddy', 'glm-5.3', 1_000))
    ledger.record(observe('workbuddy', 'deepseek-v4-pro', 1_000))

    registerUsageQueriers(ctx, [fakeRuntime()], ledger)
    await vi.waitFor(() => { expect(registry.queriers.has('workbuddy')).toBe(true) }, { timeout: 5000 })

    const querier = registry.queriers.get('workbuddy')!
    const snapshot = await querier({ provider: 'workbuddy' })
    // 两条都在：切回先前被限的模型时，它的限流信息不会凭空消失。
    expect(snapshot.rateLimits?.map(limit => limit.model).sort()).toEqual(['deepseek-v4-pro', 'glm-5.3'])
  })

  it('只有一个模型被限 → rateLimits 一条', async () => {
    const ctx = new Context()
    const registry = new CapturingRegistry()
    ctx.provide('providerUsage', registry as never)
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record(observe('workbuddy', 'glm-5.3', 1_000))

    registerUsageQueriers(ctx, [fakeRuntime()], ledger)
    await vi.waitFor(() => { expect(registry.queriers.has('workbuddy')).toBe(true) }, { timeout: 5000 })

    const snapshot = await registry.queriers.get('workbuddy')!({ provider: 'workbuddy' })
    expect(snapshot.rateLimits).toHaveLength(1)
    expect(snapshot.rateLimits?.[0]?.model).toBe('glm-5.3')
  })

  it('没有活跃限流 → rateLimits 缺席（不报空数组让界面猜）', async () => {
    const ctx = new Context()
    const registry = new CapturingRegistry()
    ctx.provide('providerUsage', registry as never)

    registerUsageQueriers(ctx, [fakeRuntime()], new RateLimitLedger({ now: () => 1_000 }))
    await vi.waitFor(() => { expect(registry.queriers.has('workbuddy')).toBe(true) }, { timeout: 5000 })

    const snapshot = await registry.queriers.get('workbuddy')!({ provider: 'workbuddy' })
    expect(snapshot.rateLimits).toBeUndefined()
  })

  it('策略字段（policy/limit/remaining/window/scope）随观测过 wire', async () => {
    const ctx = new Context()
    const registry = new CapturingRegistry()
    ctx.provide('providerUsage', registry as never)
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    for (const observation of observeRateLimits({
      provider: 'workbuddy',
      status: 429,
      kind: 'soft_rate',
      model: 'glm-5.3',
      headers: {
        get: (name: string) => ({
          'ratelimit-policy': '"rpm";q=60;w=60',
          ratelimit: '"rpm";r=0;t=30',
        } as Record<string, string>)[name.toLowerCase()] ?? null,
      },
      nowMs: 1_000,
    })) {
      ledger.record(observation)
    }

    registerUsageQueriers(ctx, [fakeRuntime()], ledger)
    await vi.waitFor(() => { expect(registry.queriers.has('workbuddy')).toBe(true) }, { timeout: 5000 })

    const snapshot = await registry.queriers.get('workbuddy')!({ provider: 'workbuddy' })
    expect(snapshot.rateLimits?.[0]).toMatchObject({
      model: 'glm-5.3',
      policy: 'rpm',
      scope: 'model',
      limit: 60,
      remaining: 0,
      windowSeconds: 60,
      resetAt: 31_000,
    })
  })

  it('别的 provider 的限流不会串进本 provider 的 rateLimits', async () => {
    const ctx = new Context()
    const registry = new CapturingRegistry()
    ctx.provide('providerUsage', registry as never)
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record(observe('zcode', 'glm-4.6', 1_000))
    ledger.record(observe('workbuddy', 'glm-5.3', 1_000))

    registerUsageQueriers(ctx, [fakeRuntime()], ledger)
    await vi.waitFor(() => { expect(registry.queriers.has('workbuddy')).toBe(true) }, { timeout: 5000 })

    const snapshot = await registry.queriers.get('workbuddy')!({ provider: 'workbuddy' })
    expect(snapshot.rateLimits?.map(limit => limit.model)).toEqual(['glm-5.3'])
  })
})
