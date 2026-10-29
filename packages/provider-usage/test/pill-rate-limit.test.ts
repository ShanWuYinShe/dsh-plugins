import { describe, expect, it } from 'vitest'
import { exhaustedResetText, headlineText, rateLimitHeadline } from '../client/pill-headline.js'
import type { ProviderUsageLocaleKey } from '../client/locales.js'
import type { UsageSnapshot } from '../src/types.js'

/**
 * 限流态与「额度用尽」态的折叠文案回归。
 *
 * 这两条是用户「到什么时候能接着用」的全部答案来源，且都必须**只说上游说过
 * 的事**：有恢复时刻就说几点，没有就说「上游没给」。编一个倒计时比不说更糟。
 */

const t = (key: ProviderUsageLocaleKey, params?: Record<string, unknown>): string => {
  if (key === 'rateLimitedUntil') return `until:${String(params!['time'])}`
  if (key === 'resetsAt') return `resets:${String(params!['time'])}`
  if (key === 'rateLimitHits') return `hits:${String(params!['count'])}`
  return key
}

function snapshotOf(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'zcode',
    windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
    fetchedAt: 0,
    ...overrides,
  }
}

describe('rateLimitHeadline', () => {
  it('上游给了恢复时刻 → 说几点恢复', () => {
    const text = rateLimitHeadline({ blockedAt: 0, lastSeenAt: 0, resetAt: Date.parse('2026-10-29T12:00:00Z'), status: 429, hits: 1 }, t)
    expect(text.startsWith('until:')).toBe(true)
  })

  it('上游没给恢复时刻 → 如实说「未给」，不编倒计时', () => {
    const text = rateLimitHeadline({ blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1 }, t)
    expect(text).toBe('rateLimitedUnknown')
  })
})

describe('headlineText：限流优先于额度数字', () => {
  it('被限流时，即使还有额度，头行也先说限流', () => {
    const text = headlineText(
      snapshotOf({ rateLimit: { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1 } }),
      'zcode',
      false,
      t,
    )
    expect(text).toBe('rateLimitedUnknown')
  })

  it('没被限流时维持额度数字（既有行为不回退）', () => {
    const text = headlineText(snapshotOf(), 'zcode', false, t)
    expect(text).toContain('remaining')
  })

  it('限流 + stale 后缀仍保留', () => {
    const text = headlineText(
      snapshotOf({ rateLimit: { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1 } }),
      'zcode',
      true,
      t,
    )
    expect(text).toContain('staleData')
  })
})

describe('exhaustedResetText：额度用尽时补恢复时刻', () => {
  it('remain 为 0 且有 resetsAt → 给出恢复时刻', () => {
    const text = exhaustedResetText(snapshotOf({
      windows: [{ id: 'w', label: '5 小时', remain: 0, unit: '%', limit: 100, resetsAt: '2026-10-29T12:00:00Z' }],
    }), t)
    expect(text?.startsWith('resets:')).toBe(true)
  })

  it('还有余额时不打扰（用户此刻能继续用）', () => {
    const text = exhaustedResetText(snapshotOf({
      windows: [{ id: 'w', label: '5 小时', remain: 30, unit: '%', limit: 100, resetsAt: '2026-10-29T12:00:00Z' }],
    }), t)
    expect(text).toBeUndefined()
  })

  it('用尽但没有 resetsAt（余额型，不会回填）→ 不给恢复时刻', () => {
    const text = exhaustedResetText(snapshotOf({
      windows: [{ id: 'w', label: '余额', remain: 0, unit: 'credits' }],
    }), t)
    expect(text).toBeUndefined()
  })

  it('没有窗口时不崩', () => {
    expect(exhaustedResetText(snapshotOf({ windows: [] }), t)).toBeUndefined()
  })
})
