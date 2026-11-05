import { describe, expect, it } from 'vitest'
import { compareRateLimitUrgency, selectRateLimitForCurrentModel } from '../client/pill-rate-limit-scope.js'
import type { UsageRateLimit, UsageSnapshot } from '../src/types.js'

/**
 * 限流归属判定回归：wire 带该 provider 的**全部**逐模型观测，pill 只挑当前
 * 选中模型那一条——换了同 provider 的另一个模型后，先前模型被限的事实不该
 * 挂在新模型上（会把「A 被限」误读成「整条通道不可用」）。
 */

function limit(model?: string): UsageRateLimit {
  return { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1, ...model === undefined ? {} : { model } }
}

function snapshotWith(rateLimits: unknown): UsageSnapshot {
  return { provider: 'workbuddy', windows: [], fetchedAt: 0, rateLimits: rateLimits as UsageSnapshot['rateLimits'] }
}

describe('selectRateLimitForCurrentModel：只显示当前选中模型的限流', () => {
  it('当前模型被限（多模型数组里精确命中）→ 显示那一条', () => {
    const snapshot = snapshotWith([limit('glm-5.3'), limit('glm-4.6')])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-4.6')?.model).toBe('glm-4.6')
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.model).toBe('glm-5.3')
  })

  it('其它模型被限、当前模型没被限 → undefined（不误报）', () => {
    expect(selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3')]), 'glm-4.6')).toBeUndefined()
  })

  it('精确命中优先于数组顺序：provider 级观测排在前面也不盖掉', () => {
    const snapshot = snapshotWith([limit(), limit('glm-5.3')])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.model).toBe('glm-5.3')
  })

  it('观测不带 model（provider 级）→ 无法判定归属，按真实限流展示', () => {
    const shown = selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3'), limit()]), 'glm-4.6')
    expect(shown?.model).toBeUndefined()
    expect(shown?.status).toBe(429)
  })

  it('当前模型未知（目录未解析/无会话）→ 不做推断，取最靠前一条', () => {
    const snapshot = snapshotWith([limit('glm-5.3'), limit('glm-4.6')])
    expect(selectRateLimitForCurrentModel(snapshot, undefined)?.model).toBe('glm-5.3')
    expect(selectRateLimitForCurrentModel(snapshot, '')?.model).toBe('glm-5.3')
  })

  it('模型名区分大小写与前后缀：不做模糊匹配', () => {
    const snapshot = snapshotWith([limit('GLM-5.3')])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3')]), 'glm-5.3-extra')).toBeUndefined()
  })

  it('wire 缺失/形状非法 → undefined，不在渲染期抛错', () => {
    expect(selectRateLimitForCurrentModel(undefined, 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith(undefined), 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith('nope'), 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3')]), 'glm-5.3')?.model).toBe('glm-5.3')
  })
})

describe('多条策略的紧迫度（同一模型被多条限流策略约束）', () => {
  /** 造一条策略观测（默认余量 0、恢复时刻 5000）。 */
  function policy(policy: string, overrides: Partial<UsageRateLimit> = {}): UsageRateLimit {
    return { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1, model: 'glm-5.3', policy, ...overrides }
  }

  it('compareRateLimitUrgency：余量耗尽的优先于未耗尽', () => {
    const exhausted = policy('rpm', { remaining: 0, resetAt: 9_000 })
    const notExhausted = policy('tpd', { remaining: 5, resetAt: 1_000 })
    expect(compareRateLimitUrgency(exhausted, notExhausted)).toBeLessThan(0)
    expect(compareRateLimitUrgency(notExhausted, exhausted)).toBeGreaterThan(0)
  })

  it('compareRateLimitUrgency：同为耗尽时恢复更早的优先；没有恢复时刻的排最后', () => {
    const soon = policy('rpm', { remaining: 0, resetAt: 5_000 })
    const late = policy('tpd', { remaining: 0, resetAt: 9_000 })
    const unknown = policy('daily', { remaining: 0 })
    expect(compareRateLimitUrgency(soon, late)).toBeLessThan(0)
    expect(compareRateLimitUrgency(unknown, soon)).toBeGreaterThan(0)
  })

  it('compareRateLimitUrgency：恢复时刻相同看余量，再相同看最近被拒时间，完全等价返回 0', () => {
    const fewer = policy('a', { remaining: 1, resetAt: 5_000 })
    const more = policy('b', { remaining: 3, resetAt: 5_000 })
    expect(compareRateLimitUrgency(fewer, more)).toBeLessThan(0)
    const older = policy('c', { remaining: 1, resetAt: 5_000, lastSeenAt: 100 })
    const newer = policy('d', { remaining: 1, resetAt: 5_000, lastSeenAt: 200 })
    expect(compareRateLimitUrgency(newer, older)).toBeLessThan(0)
    expect(compareRateLimitUrgency(newer, { ...newer })).toBe(0)
  })

  it('同一模型多条策略 → 挑最紧迫的那条（余量 0 且恢复更早）', () => {
    const snapshot = snapshotWith([
      policy('tpd', { remaining: 0, resetAt: 9_000 }),
      policy('rpm', { remaining: 0, resetAt: 5_000 }),
    ])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.policy).toBe('rpm')
  })

  it('精确匹配的模型观测仍然优先于 provider 级观测（不会因为后者更紧迫而串模型）', () => {
    const snapshot = snapshotWith([
      { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1, remaining: 0, resetAt: 1_000 },
      policy('rpm', { remaining: 5, resetAt: 9_000 }),
    ])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.policy).toBe('rpm')
  })

  it('当前模型没有精确观测时，provider 级多条策略也按紧迫度挑一条', () => {
    const snapshot = snapshotWith([
      { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1, policy: 'tpd', remaining: 0, resetAt: 9_000 },
      { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1, policy: 'rpm', remaining: 0, resetAt: 5_000 },
    ])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.policy).toBe('rpm')
  })

  it('mostUrgent：首个候选已是最紧迫时不替换（数组顺序不影响结果）', () => {
    const snapshot = snapshotWith([
      policy('rpm', { remaining: 0, resetAt: 5_000 }),
      policy('tpd', { remaining: 0, resetAt: 9_000 }),
    ])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.policy).toBe('rpm')
  })

  it('compareRateLimitUrgency：左侧未耗尽 / reset 与 remaining 缺失的兜底分支', () => {
    // 左侧 remaining !== 0（耗尽函数返回 1 的分支）。
    expect(compareRateLimitUrgency(policy('a', { remaining: 5 }), policy('b', { remaining: 0 }))).toBeGreaterThan(0)
    // 左 reset 缺失（?? UNKNOWN_RESET 的右分支）。
    expect(compareRateLimitUrgency(policy('a', { remaining: 0 }), policy('b', { remaining: 0, resetAt: 5_000 }))).toBeGreaterThan(0)
    // 右 reset 缺失。
    expect(compareRateLimitUrgency(policy('a', { remaining: 0, resetAt: 5_000 }), policy('b', { remaining: 0 }))).toBeLessThan(0)
    // reset 相同时比较 remaining，且 remaining 缺失按无限处理。
    const noRemaining = policy('a', { resetAt: 5_000 })
    const hasRemaining = policy('b', { resetAt: 5_000, remaining: 3 })
    expect(compareRateLimitUrgency(noRemaining, hasRemaining)).toBeGreaterThan(0)
    expect(compareRateLimitUrgency(hasRemaining, noRemaining)).toBeLessThan(0)
    // lastSeenAt 相同 → 完全等价返回 0。
    expect(compareRateLimitUrgency(noRemaining, { ...noRemaining })).toBe(0)
  })
})
