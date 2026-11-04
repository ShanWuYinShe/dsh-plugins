import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'
import {
  Config,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_ERROR_CACHE_TTL_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  DEFAULT_UNRESOLVED_TTL_MS,
  resolveConfig,
} from '../src/config.js'
import type { UsageSnapshot } from '../src/types.js'

/**
 * 部署可变量回归（RULE-059/060）：queryTimeout / 成功缓存 TTL / 负缓存 TTL /
 * 推断负缓存 TTL 必须在 Config schema 里有默认值，且经 apply 原样进入 registry——
 * 否则「账单接口慢时调大 deadline」「自建代理加大缓存」只能改源码。
 *
 * 全部用 fake timers 控制 Date.now，不睡墙钟。
 */

/** 按 apply 口径装好插件，拿真实的 ctx.providerUsage 服务。 */
function mount(config?: Parameters<typeof apply>[1]): Context {
  const ctx = new Context()
  apply(ctx, config)
  return ctx
}

/** 一条固定答案的 querier。 */
function querier(): () => Promise<UsageSnapshot> {
  return vi.fn(async (): Promise<UsageSnapshot> => ({
    provider: 'acme',
    windows: [{ id: 'a', label: 'A', remain: 9, unit: 'credits' }],
    fetchedAt: 0,
  }))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Config schema', () => {
  it('默认值与历史常量一致（缺省配置即旧行为）', () => {
    expect(Config({})).toEqual({
      queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
      cacheTtlMs: DEFAULT_CACHE_TTL_MS,
      errorCacheTtlMs: DEFAULT_ERROR_CACHE_TTL_MS,
      unresolvedTtlMs: DEFAULT_UNRESOLVED_TTL_MS,
    })
    // 默认值字面量本身也锁住：改动默认值必须在这里显式举手。
    expect([DEFAULT_QUERY_TIMEOUT_MS, DEFAULT_CACHE_TTL_MS, DEFAULT_ERROR_CACHE_TTL_MS, DEFAULT_UNRESOLVED_TTL_MS])
      .toEqual([15_000, 60_000, 10_000, 60_000])
  })

  it('自定义值原样保留，缺失字段补默认', () => {
    expect(resolveConfig({ cacheTtlMs: 1_234, errorCacheTtlMs: 567 })).toEqual({
      queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
      cacheTtlMs: 1_234,
      errorCacheTtlMs: 567,
      unresolvedTtlMs: DEFAULT_UNRESOLVED_TTL_MS,
    })
  })

  it('非法值加载期 fail loud（0/负数/非整数/超时上限）', () => {
    expect(() => resolveConfig({ cacheTtlMs: 0 })).toThrow()
    expect(() => resolveConfig({ cacheTtlMs: -1 })).toThrow()
    expect(() => resolveConfig({ queryTimeoutMs: 1.5 })).toThrow()
    expect(() => resolveConfig({ unresolvedTtlMs: 2_147_483_648 })).toThrow()
    expect(() => resolveConfig({ errorCacheTtlMs: Number.NaN })).toThrow()
  })

  it('apply 收到非法配置时在挂载前抛错，不留下半装状态', () => {
    expect(() => apply(new Context(), { cacheTtlMs: 0 })).toThrow()
  })
})

describe('Config 接线：apply → ProviderUsageRegistry', () => {
  it('默认成功缓存 TTL 生效：60s 内复用缓存，过期后重新查询', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const ctx = mount()
    const query = querier()
    ctx.providerUsage.register('acme', query)

    await ctx.providerUsage.snapshot('acme')
    vi.setSystemTime(1_000 + 59_000)
    await ctx.providerUsage.snapshot('acme')
    expect(query).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + 61_000)
    await ctx.providerUsage.snapshot('acme')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('自定义 cacheTtlMs 生效：短 TTL 到点即重新查询', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const ctx = mount({ cacheTtlMs: 1_000 })
    const query = querier()
    ctx.providerUsage.register('acme', query)

    await ctx.providerUsage.snapshot('acme')
    vi.setSystemTime(1_000 + 999)
    await ctx.providerUsage.snapshot('acme')
    expect(query).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + 1_001)
    await ctx.providerUsage.snapshot('acme')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('自定义 queryTimeoutMs 生效：挂死的 querier 在配置的 deadline 后结算', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const ctx = mount({ queryTimeoutMs: 5 })
    ctx.providerUsage.register('acme', async () => new Promise<UsageSnapshot>(() => {}))

    const pending = ctx.providerUsage.snapshot('acme')
    await vi.advanceTimersByTimeAsync(5)
    const snapshot = await pending
    expect(snapshot?.error).toContain('timed out')
  })

  it('自定义 unresolvedTtlMs 生效：推断无果的负缓存窗口内不重复 resolve', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const ctx = mount({ unresolvedTtlMs: 1_000 })
    const resolver = vi.fn(async () => ({ baseURL: 'https://api.unmatched.example' }))
    ctx.providerUsage.setResolver(resolver)

    expect(await ctx.providerUsage.snapshot('my-cloud')).toBeUndefined()
    vi.setSystemTime(1_000 + 999)
    expect(await ctx.providerUsage.snapshot('my-cloud')).toBeUndefined()
    expect(resolver).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + 1_001)
    expect(await ctx.providerUsage.snapshot('my-cloud')).toBeUndefined()
    expect(resolver).toHaveBeenCalledTimes(2)
  })
})
