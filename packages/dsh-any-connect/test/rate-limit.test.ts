import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATE_LIMIT_TTL_MS,
  RateLimitLedger,
  isRateLimitActive,
  observeRateLimit,
  parseResetHeader,
  parseResetMessage,
} from '../src/rate-limit.js'

/**
 * 上游 429 观测台账回归。
 *
 * 这块的整个价值在「只报上游真说过的事」：恢复时刻只能来自响应头，拿不到就
 * 必须如实说不知道。因此这里每条用例都在锁同一个边界——**不许推算**。
 */

/** 造一个带指定头的 Headers 替身。 */
function headersOf(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: name => lower.get(name.toLowerCase()) ?? null }
}

describe('parseResetHeader', () => {
  const NOW = 1_800_000_000_000 // 2027-01-15 前后，只作为基准用

  it('Retry-After 的相对秒数按 now 相加', () => {
    expect(parseResetHeader('30', NOW)).toBe(NOW + 30_000)
    expect(parseResetHeader('1.5', NOW)).toBe(NOW + 1_500)
  })

  it('X-RateLimit-Reset 的秒级 epoch 转毫秒', () => {
    // 1.8e9 秒 ≈ 2027 年：数量级落在 epoch 秒区间。
    expect(parseResetHeader('1800000000', NOW)).toBe(1_800_000_000_000)
  })

  it('X-RateLimit-Reset 的毫秒级 epoch 原样返回', () => {
    expect(parseResetHeader('1800000000123', NOW)).toBe(1_800_000_000_123)
  })

  it('HTTP-date 形态的 Retry-After 解析成绝对时刻', () => {
    const iso = 'Wed, 21 Oct 2026 07:28:00 GMT'
    // 基准取在该时刻之前一小时：重置时刻是「未来」，正是 Retry-After 的语义。
    const base = Date.parse(iso) - 3_600_000
    expect(parseResetHeader(iso, base)).toBe(Date.parse(iso))
  })

  it('明显过去的时刻不算重置时刻（避免倒计时指向已过去的瞬间）', () => {
    const iso = 'Wed, 21 Oct 2026 07:28:00 GMT'
    const longAfter = Date.parse(iso) + 2 * 86_400_000
    expect(parseResetHeader(iso, longAfter)).toBeUndefined()
  })

  it('空值、空白、非数字乱码一律 undefined（不猜）', () => {
    expect(parseResetHeader(null, NOW)).toBeUndefined()
    expect(parseResetHeader(undefined, NOW)).toBeUndefined()
    expect(parseResetHeader('   ', NOW)).toBeUndefined()
    expect(parseResetHeader('soon', NOW)).toBeUndefined()
    expect(parseResetHeader('-5', NOW)).toBeUndefined()
  })
})

describe('parseResetMessage', () => {
  // 用户实际收到的 WorkBuddy code:6004 文案（2026-10-30 实测）。
  const WORKBUDDY_6004 = '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry,'
    + ' your usage will reset at 2026-10-30 14:20:02 UTC+8, alternatively,'
    + ' you can switch to the other models to continue using it.","requestId":"46d4c00997bb45d1aa9aa9806bd1cbea"}'
  const NOW = Date.UTC(2026, 9, 30, 3, 0, 0)

  it('解析 WorkBuddy code:6004 的 reset at <时间> UTC+8', () => {
    // 14:20:02 UTC+8 = 06:20:02 UTC。
    expect(parseResetMessage(WORKBUDDY_6004, NOW)).toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('支持 UTC+08:00 时区写法', () => {
    expect(parseResetMessage('will reset at 2026-10-30 14:20:02 UTC+08:00', NOW))
      .toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('没有显式时区不解析（不猜上游时区）', () => {
    expect(parseResetMessage('will reset at 2026-10-30 14:20:02', NOW)).toBeUndefined()
  })

  it('日历上不存在的日期不解析（02-30 不能被顺延成 03-02）', () => {
    expect(parseResetMessage('reset at 2026-02-30 14:20:02 UTC+8', NOW)).toBeUndefined()
  })

  it('明显过去的时刻不算恢复时刻', () => {
    expect(parseResetMessage(WORKBUDDY_6004, Date.UTC(2026, 10, 2))).toBeUndefined()
  })

  it('空值与不含该文案的正文返回 undefined', () => {
    expect(parseResetMessage(undefined, NOW)).toBeUndefined()
    expect(parseResetMessage('rate limited', NOW)).toBeUndefined()
  })
})

describe('observeRateLimit', () => {
  it('429 归类为限流并保留上游给的重置时刻', () => {
    const observation = observeRateLimit({
      provider: 'zcode',
      status: 429,
      kind: 'soft_rate',
      model: 'glm-5.3',
      headers: headersOf({ 'retry-after': '60' }),
      nowMs: 1_000_000,
    })
    expect(observation).toBeDefined()
    expect(observation!.provider).toBe('zcode')
    expect(observation!.status).toBe(429)
    expect(observation!.model).toBe('glm-5.3')
    expect(observation!.resetAtMs).toBe(1_060_000)
    expect(observation!.hits).toBe(1)
  })

  it('没有重置头时 resetAtMs 缺席（这是要如实展示的事实，不是缺口）', () => {
    const observation = observeRateLimit({ provider: 'zcode', status: 429, kind: 'soft_rate', nowMs: 1_000 })
    expect(observation).toBeDefined()
    expect('resetAtMs' in observation!).toBe(false)
  })

  it('响应头没给时，采纳错误体里明写的恢复时刻', () => {
    const observation = observeRateLimit({
      provider: 'workbuddy',
      status: 429,
      kind: 'soft_rate',
      body: '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry,'
        + ' your usage will reset at 2026-10-30 14:20:02 UTC+8"}',
      nowMs: Date.UTC(2026, 9, 30, 3, 0, 0),
    })
    expect(observation!.resetAtMs).toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('响应头的恢复时刻优先于错误体文案', () => {
    const observation = observeRateLimit({
      provider: 'workbuddy',
      status: 429,
      kind: 'soft_rate',
      headers: headersOf({ 'retry-after': '60' }),
      body: 'will reset at 2026-10-30 14:20:02 UTC+8',
      nowMs: 1_000_000,
    })
    expect(observation!.resetAtMs).toBe(1_060_000)
  })

  it('X-RateLimit-Reset 优先于缺失的 Retry-After', () => {
    const observation = observeRateLimit({
      provider: 'openrouter',
      status: 429,
      kind: 'soft_rate',
      headers: headersOf({ 'x-ratelimit-reset': '1800000000' }),
      nowMs: 1_000,
    })
    expect(observation!.resetAtMs).toBe(1_800_000_000_000)
  })

  it('OpenCode 免费通道的 403 FreeTierError 也算限流（soft_rate）', () => {
    const observation = observeRateLimit({ provider: 'opencode-free', status: 403, kind: 'soft_rate', nowMs: 5 })
    expect(observation).toBeDefined()
    expect(observation!.status).toBe(403)
  })

  it('非限流失败不产生观测', () => {
    expect(observeRateLimit({ provider: 'x', status: 500, kind: 'server' })).toBeUndefined()
    expect(observeRateLimit({ provider: 'x', status: 401, kind: 'session_dead' })).toBeUndefined()
    expect(observeRateLimit({ provider: 'x', status: 402, kind: 'hard_credit' })).toBeUndefined()
  })
})

describe('isRateLimitActive', () => {
  const base = { provider: 'zcode', blockedAtMs: 0, lastSeenAtMs: 0, status: 429, kind: 'soft_rate', hits: 1 }

  it('有 resetAt 时以它为准：过了就解除', () => {
    expect(isRateLimitActive({ ...base, resetAtMs: 1_000 }, 999)).toBe(true)
    expect(isRateLimitActive({ ...base, resetAtMs: 1_000 }, 1_000)).toBe(false)
  })

  it('没有 resetAt 时按 TTL 判定', () => {
    expect(isRateLimitActive(base, DEFAULT_RATE_LIMIT_TTL_MS - 1)).toBe(true)
    expect(isRateLimitActive(base, DEFAULT_RATE_LIMIT_TTL_MS)).toBe(false)
  })
})

describe('RateLimitLedger', () => {
  it('同一段限流期内重复撞到：保留最早时刻、累加次数、采用最新重置时刻', () => {
    let now = 1_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.record({ provider: 'zcode', blockedAtMs: now, lastSeenAtMs: now, status: 429, kind: 'soft_rate', hits: 1 })
    now = 5_000
    const merged = ledger.record({
      provider: 'zcode',
      blockedAtMs: now,
      lastSeenAtMs: now,
      resetAtMs: 9_000,
      status: 429,
      kind: 'soft_rate',
      hits: 1,
    })
    expect(merged.blockedAtMs).toBe(1_000) // 用户想知道「等了多久」
    expect(merged.lastSeenAtMs).toBe(5_000)
    expect(merged.hits).toBe(2)
    expect(merged.resetAtMs).toBe(9_000)
  })

  it('上一次已过期后再撞：算新的一段，重新计时', () => {
    let now = 1_000
    const ledger = new RateLimitLedger({ now: () => now, ttlMs: 100 })
    ledger.record({ provider: 'zcode', blockedAtMs: now, lastSeenAtMs: now, status: 429, kind: 'soft_rate', hits: 1 })
    now = 10_000
    const fresh = ledger.record({ provider: 'zcode', blockedAtMs: now, lastSeenAtMs: now, status: 429, kind: 'soft_rate', hits: 1 })
    expect(fresh.blockedAtMs).toBe(10_000)
    expect(fresh.hits).toBe(1)
  })

  it('新观测没带重置时刻时沿用上一次的（上游不是每次都回全）', () => {
    let now = 1_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.record({ provider: 'z', blockedAtMs: now, lastSeenAtMs: now, resetAtMs: 60_000, status: 429, kind: 'soft_rate', hits: 1 })
    now = 2_000
    const merged = ledger.record({ provider: 'z', blockedAtMs: now, lastSeenAtMs: now, status: 429, kind: 'soft_rate', hits: 1 })
    expect(merged.resetAtMs).toBe(60_000)
  })

  it('成功请求 clear 之后不再活跃', () => {
    let now = 1_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.record({ provider: 'zcode', blockedAtMs: now, lastSeenAtMs: now, status: 429, kind: 'soft_rate', hits: 1 })
    expect(ledger.activeFor('zcode')).toBeDefined()
    ledger.clear('zcode')
    expect(ledger.activeFor('zcode')).toBeUndefined()
  })

  it('按 provider 隔离：一个变体被限不影响另一个', () => {
    let now = 1_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.record({ provider: 'zcode', blockedAtMs: now, lastSeenAtMs: now, status: 429, kind: 'soft_rate', hits: 1 })
    expect(ledger.activeFor('zcode')).toBeDefined()
    expect(ledger.activeFor('workbuddy')).toBeUndefined()
    expect(ledger.snapshot().active).toHaveLength(1)
    expect(ledger.snapshot('zcode').active).toHaveLength(1)
  })

  it('resetAt 已过的观测不再算活跃，但仍在 recent 里可查', () => {
    let now = 1_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.record({ provider: 'zcode', blockedAtMs: now, lastSeenAtMs: now, resetAtMs: 2_000, status: 429, kind: 'soft_rate', hits: 1 })
    now = 2_001
    expect(ledger.activeFor('zcode')).toBeUndefined()
    expect(ledger.snapshot().recent).toHaveLength(1)
  })
})
