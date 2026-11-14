import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RATE_LIMIT_TTL_MS,
  RateLimitLedger,
  attachRateLimitPersistence,
  isRateLimitActive,
  observeRateLimits,
  parseDeltaSeconds,
  parseDurationMs,
  parseEpochReset,
  parseRateLimitPolicies,
  parseResetMessage,
  parseRetryAfter,
  resolveHeaderResetAt,
} from '../src/rate-limit.js'
import type { RateLimitObservation, RateLimitPersistence } from '../src/rate-limit.js'

/**
 * 上游 429 观测台账回归（策略感知 + 持久化）。
 *
 * 这块的整个价值在「只报上游真说过的事」：恢复时刻只能来自响应头/错误正文，
 * 拿不到就必须如实说不知道；策略字段（policy/limit/remaining/window）同理——
 * 有才展示，没有就缺席。因此这里每条用例都在锁同一个边界：**不许推算**。
 */

/** 造一个带指定头的 Headers 替身。 */
function headersOf(entries: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]))
  return { get: name => lower.get(name.toLowerCase()) ?? null }
}

const NOW = 1_800_000_000_000 // 2027-01-15 前后，只作为基准用

describe('parseRetryAfter（RFC 9110：delta 秒或 HTTP-date）', () => {
  it('相对秒数按 now 相加', () => {
    expect(parseRetryAfter('30', NOW)).toBe(NOW + 30_000)
    expect(parseRetryAfter('1.5', NOW)).toBe(NOW + 1_500)
    // delta-seconds 没有量级上限：大数字仍是相对秒，不是 epoch。
    expect(parseRetryAfter('1800000000', NOW)).toBe(NOW + 1_800_000_000_000)
  })

  it('HTTP-date 形态解析成绝对时刻', () => {
    const iso = 'Wed, 21 Oct 2026 07:28:00 GMT'
    const base = Date.parse(iso) - 3_600_000
    expect(parseRetryAfter(iso, base)).toBe(Date.parse(iso))
  })

  it('明显过去的时刻不算重置时刻', () => {
    const iso = 'Wed, 21 Oct 2026 07:28:00 GMT'
    const longAfter = Date.parse(iso) + 2 * 86_400_000
    expect(parseRetryAfter(iso, longAfter)).toBeUndefined()
  })

  it('空值、空白、非数字乱码、负数一律 undefined（不猜）', () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined()
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined()
    expect(parseRetryAfter('   ', NOW)).toBeUndefined()
    expect(parseRetryAfter('soon', NOW)).toBeUndefined()
    expect(parseRetryAfter('-5', NOW)).toBeUndefined()
  })
})

describe('parseEpochReset（X-RateLimit-Reset 的 epoch 形态）', () => {
  it('秒级 epoch 转毫秒', () => {
    expect(parseEpochReset('1800000000', NOW)).toBe(1_800_000_000_000)
  })

  it('毫秒级 epoch 原样返回', () => {
    expect(parseEpochReset('1800000000123', NOW)).toBe(1_800_000_000_123)
  })

  it('小数字不是 epoch，不能当 delta 秒猜', () => {
    expect(parseEpochReset('30', NOW)).toBeUndefined()
    expect(parseEpochReset('0', NOW)).toBeUndefined()
  })

  it('过去超过一天的时刻不采用', () => {
    expect(parseEpochReset('1800000000', NOW + 2 * 86_400_000)).toBeUndefined()
  })

  it('非数字与空值 undefined', () => {
    expect(parseEpochReset('abc', NOW)).toBeUndefined()
    expect(parseEpochReset('', NOW)).toBeUndefined()
    expect(parseEpochReset(null, NOW)).toBeUndefined()
  })
})

describe('parseDeltaSeconds（旧版 RateLimit-Reset / IETF 的 t）', () => {
  it('数字按相对秒解释', () => {
    expect(parseDeltaSeconds('30', NOW)).toBe(NOW + 30_000)
  })

  it('非数字与负数 undefined', () => {
    expect(parseDeltaSeconds('soon', NOW)).toBeUndefined()
    expect(parseDeltaSeconds('-1', NOW)).toBeUndefined()
    expect(parseDeltaSeconds(null, NOW)).toBeUndefined()
  })
})

describe('parseDurationMs（OpenAI 的 reset 时长串）', () => {
  it('支持秒/分钟/小时/毫秒组合', () => {
    expect(parseDurationMs('1s')).toBe(1_000)
    expect(parseDurationMs('6m0s')).toBe(360_000)
    expect(parseDurationMs('500ms')).toBe(500)
    expect(parseDurationMs('1h2m3s')).toBe(3_723_000)
  })

  it('纯数字按秒解释', () => {
    expect(parseDurationMs('90')).toBe(90_000)
  })

  it('畸形值不猜', () => {
    expect(parseDurationMs('1m junk')).toBeUndefined()
    expect(parseDurationMs('1x')).toBeUndefined()
    expect(parseDurationMs('')).toBeUndefined()
    expect(parseDurationMs(null)).toBeUndefined()
  })

  it('超长数字（解析为 Infinity）不是有效时长', () => {
    expect(parseDurationMs('9'.repeat(400) + 's')).toBeUndefined()
  })
})

describe('parseRateLimitPolicies（标准头 / 厂商头 / 旧版独立头）', () => {
  it('IETF RateLimit + RateLimit-Policy：r/t 与 q/w 合并成一条策略事实', () => {
    const facts = parseRateLimitPolicies(headersOf({
      'ratelimit-policy': '"default";q=100;w=60',
      ratelimit: '"default";r=0;t=30',
    }), NOW)
    expect(facts).toEqual([{
      policy: 'default',
      limit: 100,
      windowSeconds: 60,
      remaining: 0,
      resetAtMs: NOW + 30_000,
    }])
  })

  it('多条命名策略：按名字配对，各自一条', () => {
    const facts = parseRateLimitPolicies(headersOf({
      'ratelimit-policy': '"rpm";q=60;w=60, "tpd";q=1000;w=86400',
      ratelimit: '"rpm";r=0;t=10, "tpd";r=0;t=60',
    }), NOW)
    expect(facts).toHaveLength(2)
    expect(facts.map(fact => fact.policy).sort()).toEqual(['rpm', 'tpd'])
    expect(facts.find(fact => fact.policy === 'rpm')?.windowSeconds).toBe(60)
    expect(facts.find(fact => fact.policy === 'tpd')?.limit).toBe(1000)
  })

  it('单条未命名策略项也能与唯一的 Policy 项配对', () => {
    const facts = parseRateLimitPolicies(headersOf({
      'ratelimit-policy': '"default";q=100;w=60',
      ratelimit: 'r=0;t=30',
    }), NOW)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.limit).toBe(100)
    expect(facts[0]?.resetAtMs).toBe(NOW + 30_000)
  })

  it('OpenAI 风格 metric 头：只在余量为 0 时采信', () => {
    const facts = parseRateLimitPolicies(headersOf({
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-requests': '6m0s',
    }), NOW)
    expect(facts).toEqual([{
      policy: 'requests',
      metric: 'requests',
      limit: 60,
      remaining: 0,
      resetAtMs: NOW + 360_000,
    }])
  })

  it('Anthropic 风格 metric 头：reset 是 RFC3339 绝对时刻', () => {
    const resetIso = '2027-02-01T00:00:00Z'
    const facts = parseRateLimitPolicies(headersOf({
      'anthropic-ratelimit-tokens-limit': '100000',
      'anthropic-ratelimit-tokens-remaining': '0',
      'anthropic-ratelimit-tokens-reset': resetIso,
    }), NOW)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ policy: 'tokens', metric: 'tokens', limit: 100000, remaining: 0 })
    expect(facts[0]?.resetAtMs).toBe(Date.parse(resetIso))
  })

  it('余量仍为正的厂商 metric 头不能解释 429，不采信', () => {
    expect(parseRateLimitPolicies(headersOf({
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '5',
      'x-ratelimit-reset-requests': '1s',
    }), NOW)).toEqual([])
  })

  it('旧版独立头：RateLimit-Reset 是 delta 秒', () => {
    const facts = parseRateLimitPolicies(headersOf({
      'ratelimit-limit': '100',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '30',
    }), NOW)
    expect(facts).toEqual([{ limit: 100, remaining: 0, resetAtMs: NOW + 30_000 }])
  })

  it('优先级：标准头 > 厂商 metric 头 > 旧版独立头', () => {
    const facts = parseRateLimitPolicies(headersOf({
      'ratelimit-policy': '"p";q=10;w=60',
      ratelimit: '"p";r=0;t=5',
      'x-ratelimit-limit-requests': '60',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-requests': '1s',
      'ratelimit-limit': '100',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '30',
    }), NOW)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.policy).toBe('p')
  })

  it('没有头 / 全是垃圾时不产生事实', () => {
    expect(parseRateLimitPolicies(undefined, NOW)).toEqual([])
    expect(parseRateLimitPolicies(headersOf({}), NOW)).toEqual([])
    expect(parseRateLimitPolicies(headersOf({ ratelimit: 'garbage', 'ratelimit-policy': '"x";q=abc' }), NOW)).toEqual([])
  })
})

describe('resolveHeaderResetAt（聊天错误提示的恢复时刻）', () => {
  it('策略事实优先于 Retry-After', () => {
    expect(resolveHeaderResetAt(headersOf({
      'ratelimit-policy': '"p";q=10;w=60',
      ratelimit: '"p";r=0;t=5',
      'retry-after': '60',
    }), NOW)).toBe(NOW + 5_000)
  })

  it('没有策略头时依次用 Retry-After / X-RateLimit-Reset', () => {
    expect(resolveHeaderResetAt(headersOf({ 'retry-after': '60' }), NOW)).toBe(NOW + 60_000)
    expect(resolveHeaderResetAt(headersOf({ 'x-ratelimit-reset': '1800000000' }), NOW)).toBe(1_800_000_000_000)
    // 少数实现把 X-RateLimit-Reset 写成 delta 秒：epoch 量级之外按相对秒解释。
    expect(resolveHeaderResetAt(headersOf({ 'x-ratelimit-reset': '30' }), NOW)).toBe(NOW + 30_000)
    expect(resolveHeaderResetAt(undefined, NOW)).toBeUndefined()
  })
})

describe('parseResetMessage', () => {
  // 用户实际收到的 WorkBuddy code:6004 文案（2026-10-30 实测）。
  const WORKBUDDY_6004 = '{"code":6004,"msg":"usage exceeds frequency limit, but don\'t worry,'
    + ' your usage will reset at 2026-10-30 14:20:02 UTC+8, alternatively,'
    + ' you can switch to the other models to continue using it.","requestId":"46d4c00997bb45d1aa9aa9806bd1cbea"}'
  const MESSAGE_NOW = Date.UTC(2026, 9, 30, 3, 0, 0)

  it('解析 WorkBuddy code:6004 的 reset at <时间> UTC+8', () => {
    expect(parseResetMessage(WORKBUDDY_6004, MESSAGE_NOW)).toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('支持 UTC+08:00 时区写法', () => {
    expect(parseResetMessage('will reset at 2026-10-30 14:20:02 UTC+08:00', MESSAGE_NOW))
      .toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('WorkBuddy 官方口径：省略时区时按 UTC+8（上海壁钟）解释', () => {
    expect(parseResetMessage('your usage will reset at 2026-10-30 14:20:02, alternatively switch models', MESSAGE_NOW))
      .toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('接受 (UTC+8) 括号写法与 T 分隔符', () => {
    expect(parseResetMessage('reset at 2026-10-30T14:20:02 (UTC+8)', MESSAGE_NOW))
      .toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('接受 ISO 偏移写法 +08:00', () => {
    expect(parseResetMessage('will reset at 2026-10-30T14:20:02+08:00', MESSAGE_NOW))
      .toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('中文正文同样识别（恢复时刻不依赖英文 reset 前缀）', () => {
    expect(parseResetMessage('当前模型使用频率超限，将于 2026-10-30 14:20:02 (UTC+8) 后恢复', MESSAGE_NOW))
      .toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('正文有多个时刻时优先取 reset 附近的那个', () => {
    expect(parseResetMessage('started 2026-10-30 10:00:00, your usage will reset at 2026-10-30 14:20:02 UTC+8', MESSAGE_NOW))
      .toBe(Date.UTC(2026, 9, 30, 6, 20, 2))
  })

  it('解析真实中文 6004 文案（2026-11-03 实测样本）', () => {
    const body = JSON.stringify({
      code: 6004,
      msg: '您的使用量已超出频率限制，将在 2026-11-04 09:46:40 UTC+8 重置，您也可以切换其他模型继续使用。',
      requestId: 'ebb485708428468495b53080014cda53',
    })
    const observedAt = Date.parse('2026-11-03T21:05:34+08:00')
    expect(parseResetMessage(body, observedAt)).toBe(Date.parse('2026-11-04T09:46:40+08:00'))
  })

  it('调用方可以覆盖裸壁钟的时区解释', () => {
    expect(parseResetMessage('will reset at 2026-10-30 14:20:02', MESSAGE_NOW, { bareWallClockOffsetMinutes: 0 }))
      .toBe(Date.UTC(2026, 9, 30, 14, 20, 2))
  })

  it('日历上不存在的日期不解析（02-30 不能被顺延成 03-02）', () => {
    expect(parseResetMessage('reset at 2026-02-30 14:20:02 UTC+8', MESSAGE_NOW)).toBeUndefined()
  })

  it('明显过去的时刻不算恢复时刻', () => {
    expect(parseResetMessage(WORKBUDDY_6004, Date.UTC(2026, 10, 2))).toBeUndefined()
  })

  it('空值与不含该文案的正文返回 undefined', () => {
    expect(parseResetMessage(undefined, MESSAGE_NOW)).toBeUndefined()
    expect(parseResetMessage('rate limited', MESSAGE_NOW)).toBeUndefined()
  })
})

describe('解析器的边界分支', () => {
  it('结构化字段：引号内转义、裸名、带逗号的引号参数、空成员/空参数', () => {
    // 引号内的转义引号（policy 名里含 "）。
    expect(parseRateLimitPolicies(headersOf({ ratelimit: '"a\\"b";r=0;t=10' }), NOW)[0]?.policy).toBe('a"b')
    // 不带引号的裸名。
    expect(parseRateLimitPolicies(headersOf({ ratelimit: 'default;r=0;t=10' }), NOW)[0]?.policy).toBe('default')
    // 引号参数值里的逗号不能被当成分隔符。
    const withQuotedParam = parseRateLimitPolicies(headersOf({ ratelimit: '"p";r=0;t=10;note="a,b"' }), NOW)
    expect(withQuotedParam).toHaveLength(1)
    // 空成员与空参数跳过，合法参数照常解析。
    expect(parseRateLimitPolicies(headersOf({ ratelimit: ', ,' }), NOW)).toEqual([])
    expect(parseRateLimitPolicies(headersOf({ ratelimit: '"x";r=;t=10' }), NOW))
      .toEqual([{ policy: 'x', resetAtMs: NOW + 10_000 }])
    // 空 header 值。
    expect(parseRateLimitPolicies(headersOf({ ratelimit: '   ', 'ratelimit-policy': '  ' }), NOW)).toEqual([])
    // 未闭合引号/末尾反斜杠：不抛错，也不产生事实。
    expect(parseRateLimitPolicies(headersOf({ ratelimit: '"x\\' }), NOW)).toEqual([])
  })

  it('策略参数为负或为 0 时不采信（q=-5/w=0 只剩重置时刻）', () => {
    const facts = parseRateLimitPolicies(headersOf({
      'ratelimit-policy': '"x";q=-5;w=0',
      ratelimit: '"x";r=0;t=10',
    }), NOW)
    expect(facts).toEqual([{ policy: 'x', resetAtMs: NOW + 10_000, remaining: 0 }])
  })

  it('厂商 metric 头缺 reset 时不猜重置时刻，但仍记录余量 0 的策略', () => {
    expect(parseRateLimitPolicies(headersOf({ 'anthropic-ratelimit-requests-remaining': '0' }), NOW))
      .toEqual([{ policy: 'requests', metric: 'requests', remaining: 0 }])
  })

  it('resolveHeaderResetAt 回落到厂商时长头', () => {
    expect(resolveHeaderResetAt(headersOf({ 'x-ratelimit-reset-requests': '1s' }), NOW)).toBe(NOW + 1_000)
  })

  it('正文多个时刻且没有 reset 关键词 → 取第一个', () => {
    expect(parseResetMessage('at 2026-10-30 10:00:00 and 2026-10-30 14:20:02 UTC+8', Date.UTC(2026, 9, 30, 3)))
      .toBe(Date.UTC(2026, 9, 30, 2))
  })
})

describe('observeRateLimits', () => {
  it('429 归类为限流并保留上游给的重置时刻与模型归属', () => {
    const observations = observeRateLimits({
      provider: 'zcode',
      status: 429,
      kind: 'soft_rate',
      model: 'glm-5.3',
      headers: headersOf({ 'retry-after': '60' }),
      nowMs: 1_000_000,
    })
    expect(observations).toHaveLength(1)
    const [observation] = observations
    expect(observation!.provider).toBe('zcode')
    expect(observation!.status).toBe(429)
    expect(observation!.model).toBe('glm-5.3')
    expect(observation!.scope).toBe('model')
    expect(observation!.resetAtMs).toBe(1_060_000)
    expect(observation!.hits).toBe(1)
  })

  it('模型未知时归属为 account 级事实', () => {
    const [observation] = observeRateLimits({ provider: 'zcode', status: 429, kind: 'soft_rate', nowMs: 1_000 })
    expect(observation!.scope).toBe('account')
    expect('model' in observation!).toBe(false)
  })

  it('没有重置头时 resetAtMs 缺席（这是要如实展示的事实，不是缺口）', () => {
    const [observation] = observeRateLimits({ provider: 'zcode', status: 429, kind: 'soft_rate', nowMs: 1_000 })
    expect('resetAtMs' in observation!).toBe(false)
  })

  it('响应头没给时，采纳错误体里明写的恢复时刻', () => {
    const [observation] = observeRateLimits({
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
    const [observation] = observeRateLimits({
      provider: 'workbuddy',
      status: 429,
      kind: 'soft_rate',
      headers: headersOf({ 'retry-after': '60' }),
      body: 'will reset at 2026-10-30 14:20:02 UTC+8',
      nowMs: 1_000_000,
    })
    expect(observation!.resetAtMs).toBe(1_060_000)
  })

  it('X-RateLimit-Reset 的 epoch 解析为绝对时刻', () => {
    const [observation] = observeRateLimits({
      provider: 'openrouter',
      status: 429,
      kind: 'soft_rate',
      headers: headersOf({ 'x-ratelimit-reset': '1800000000' }),
      nowMs: 1_000,
    })
    expect(observation!.resetAtMs).toBe(1_800_000_000_000)
  })

  it('403 状态码且 kind 为 soft_rate 时也算限流', () => {
    const observations = observeRateLimits({ provider: 'custom-provider', status: 403, kind: 'soft_rate', nowMs: 5 })
    expect(observations).toHaveLength(1)
    expect(observations[0]!.status).toBe(403)
  })

  it('非限流失败不产生观测', () => {
    expect(observeRateLimits({ provider: 'x', status: 500, kind: 'server' })).toEqual([])
    expect(observeRateLimits({ provider: 'x', status: 401, kind: 'session_dead' })).toEqual([])
    expect(observeRateLimits({ provider: 'x', status: 402, kind: 'hard_credit' })).toEqual([])
  })

  it('一条响应里的多条策略各生成一条观测（策略字段透传）', () => {
    const observations = observeRateLimits({
      provider: 'workbuddy',
      status: 429,
      kind: 'soft_rate',
      model: 'glm-5.3',
      headers: headersOf({
        'ratelimit-policy': '"rpm";q=60;w=60, "tpd";q=1000;w=86400',
        ratelimit: '"rpm";r=0;t=10, "tpd";r=0;t=60',
      }),
      nowMs: NOW,
    })
    expect(observations).toHaveLength(2)
    expect(observations.map(entry => entry.policy)).toEqual(['rpm', 'tpd'])
    expect(observations.map(entry => entry.scope)).toEqual(['model', 'model'])
    expect(observations[0]?.limit).toBe(60)
    expect(observations[1]?.windowSeconds).toBe(86400)
  })

  it('策略事实缺 t 时用兜底恢复时刻（Retry-After）补齐', () => {
    const [observation] = observeRateLimits({
      provider: 'workbuddy',
      status: 429,
      kind: 'soft_rate',
      headers: headersOf({
        'x-ratelimit-limit-requests': '60',
        'x-ratelimit-remaining-requests': '0',
        'retry-after': '90',
      }),
      nowMs: NOW,
    })
    expect(observation!.policy).toBe('requests')
    expect(observation!.resetAtMs).toBe(NOW + 90_000)
  })

  it('重复的策略名只记一条（防御上游重复输出）', () => {
    const observations = observeRateLimits({
      provider: 'workbuddy',
      status: 429,
      kind: 'soft_rate',
      headers: headersOf({ ratelimit: '"default";r=0;t=10, "default";r=0;t=20' }),
      nowMs: NOW,
    })
    expect(observations).toHaveLength(1)
    expect(observations[0]?.resetAtMs).toBe(NOW + 10_000)
  })
})

describe('isRateLimitActive', () => {
  const base: RateLimitObservation = { provider: 'zcode', blockedAtMs: 0, lastSeenAtMs: 0, status: 429, kind: 'soft_rate', hits: 1 }

  it('有 resetAt 时以它为准：过了就解除', () => {
    expect(isRateLimitActive({ ...base, resetAtMs: 1_000 }, 999)).toBe(true)
    expect(isRateLimitActive({ ...base, resetAtMs: 1_000 }, 1_000)).toBe(false)
  })

  it('没有 resetAt 时按 TTL 判定', () => {
    expect(isRateLimitActive(base, DEFAULT_RATE_LIMIT_TTL_MS - 1)).toBe(true)
    expect(isRateLimitActive(base, DEFAULT_RATE_LIMIT_TTL_MS)).toBe(false)
  })
})

describe('RateLimitLedger：合并与清理', () => {
  it('同一行重复撞到：保留最早时刻、累加次数、采用最新重置时刻', () => {
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

  it('同一模型的多个策略各占一行，互不覆盖', () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record({ provider: 'wb', blockedAtMs: 1_000, lastSeenAtMs: 1_000, status: 429, kind: 'soft_rate', model: 'glm-5.3', policy: 'rpm', hits: 1 })
    ledger.record({ provider: 'wb', blockedAtMs: 1_000, lastSeenAtMs: 1_000, status: 429, kind: 'soft_rate', model: 'glm-5.3', policy: 'tpd', hits: 1 })
    expect(ledger.activesFor('wb').map(entry => entry.policy).sort()).toEqual(['rpm', 'tpd'])
  })

  it('成功请求 clear 之后不再活跃', () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record({ provider: 'zcode', blockedAtMs: 1_000, lastSeenAtMs: 1_000, status: 429, kind: 'soft_rate', hits: 1 })
    expect(ledger.activeFor('zcode')).toBeDefined()
    ledger.clear('zcode')
    expect(ledger.activeFor('zcode')).toBeUndefined()
  })

  it('按 provider 隔离：一个变体被限不影响另一个', () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record({ provider: 'zcode', blockedAtMs: 1_000, lastSeenAtMs: 1_000, status: 429, kind: 'soft_rate', hits: 1 })
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

describe('RateLimitLedger：按模型/策略分账', () => {
  function observation(model: string | undefined, policy?: string, nowMs = 1_000): RateLimitObservation {
    return {
      provider: 'workbuddy',
      blockedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      status: 429,
      kind: 'soft_rate',
      ...model === undefined ? {} : { model },
      ...policy === undefined ? {} : { policy },
      hits: 1,
    }
  }

  it('同一 provider 的不同模型各自一条观测，互不覆盖', () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record(observation('glm-5.3'))
    ledger.record(observation('deepseek-v4-pro'))
    expect(ledger.activesFor('workbuddy').map(entry => entry.model).sort()).toEqual(['deepseek-v4-pro', 'glm-5.3'])
  })

  it('一次成功只清对应模型：B 成功不能清掉仍在限流的 A（含其全部策略）', () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record(observation('glm-5.3', 'rpm'))
    ledger.record(observation('glm-5.3', 'tpd'))
    ledger.record(observation('deepseek-v4-pro'))
    ledger.clear('workbuddy', 'deepseek-v4-pro')
    expect(ledger.activesFor('workbuddy').map(entry => entry.policy).sort()).toEqual(['rpm', 'tpd'])
  })

  it('不传模型时清该 provider 的全部观测', () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record(observation('glm-5.3'))
    ledger.record(observation(undefined))
    ledger.clear('workbuddy')
    expect(ledger.activesFor('workbuddy')).toEqual([])
  })

  it('同模型再次撞限流合并为同一条：保留最早时刻并累加次数', () => {
    let now = 1_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.record(observation('glm-5.3'))
    now = 3_000
    ledger.record(observation('glm-5.3', undefined, 3_000))
    const active = ledger.activeFor('workbuddy')
    expect(active?.model).toBe('glm-5.3')
    expect(active?.blockedAtMs).toBe(1_000)
    expect(active?.lastSeenAtMs).toBe(3_000)
    expect(active?.hits).toBe(2)
  })

  it('模型未知的 provider 级观测与模型级观测并存，模型成功时一并清掉 provider 级', () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.record(observation(undefined))
    ledger.record(observation('glm-5.3'))
    ledger.clear('workbuddy', 'glm-5.3')
    expect(ledger.activesFor('workbuddy')).toEqual([])
  })
})

describe('RateLimitLedger：持久化', () => {
  /** 造一个记录所有 save 调用的持久化替身。 */
  function persistenceOf(saved: Map<string, readonly RateLimitObservation[]>, load?: (provider: string) => Promise<readonly RateLimitObservation[] | undefined>): RateLimitPersistence {
    return {
      load: load ?? (async () => undefined),
      save: async (provider, observations) => {
        saved.set(provider, observations)
      },
    }
  }

  function resetObservation(overrides: Partial<RateLimitObservation> = {}): RateLimitObservation {
    return {
      provider: 'workbuddy',
      blockedAtMs: 1_000,
      lastSeenAtMs: 1_000,
      resetAtMs: 60 * 60 * 1000,
      status: 429,
      kind: 'soft_rate',
      model: 'glm-5.3',
      policy: 'rpm',
      hits: 1,
      ...overrides,
    }
  }

  it('record 后异步落盘：只保存带 resetAt 的观测', async () => {
    const saved = new Map<string, readonly RateLimitObservation[]>()
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.setPersistence(persistenceOf(saved))
    ledger.record(resetObservation())
    ledger.record({ ...resetObservation({ policy: 'tpd' }), resetAtMs: undefined })
    await ledger.flush()
    const persisted = saved.get('workbuddy') ?? []
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.policy).toBe('rpm')
  })

  it('restore 只恢复仍活跃且带 resetAt 的观测', async () => {
    const now = 100_000
    const saved = new Map<string, readonly RateLimitObservation[]>()
    const persistence = persistenceOf(saved, async () => [
      resetObservation({ resetAtMs: now + 60_000 }),
      resetObservation({ resetAtMs: now - 60_000 }),
      resetObservation({ resetAtMs: undefined, policy: 'no-reset' }),
    ])
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.setPersistence(persistence)
    const restored = await ledger.restore('workbuddy')
    expect(restored).toBe(1)
    expect(ledger.activesFor('workbuddy').map(entry => entry.policy)).toEqual(['rpm'])
  })

  it('没有注入持久化时 restore 返回 0（CLI/测试构造也安全）', async () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    await expect(ledger.restore('workbuddy')).resolves.toBe(0)
  })

  it('清除观测后落盘空数组（不留空壳记录）', async () => {
    const saved = new Map<string, readonly RateLimitObservation[]>()
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.setPersistence(persistenceOf(saved))
    ledger.record(resetObservation())
    await ledger.flush()
    expect(saved.get('workbuddy')).toHaveLength(1)
    ledger.clear('workbuddy', 'glm-5.3')
    await ledger.flush()
    expect(saved.get('workbuddy')).toEqual([])
  })

  it('restore 不会用旧快照覆盖本进程更新鲜的观测', async () => {
    const now = 5_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.setPersistence({ load: async () => [resetObservation({ resetAtMs: 60_000, lastSeenAtMs: 1_000 })], save: async () => {} })
    ledger.record({ ...resetObservation({ resetAtMs: 60_000 }), lastSeenAtMs: 5_000 })
    await ledger.restore('workbuddy')
    expect(ledger.activeFor('workbuddy')?.lastSeenAtMs).toBe(5_000)
  })

  it('restore 用更新鲜的持久化快照覆盖更旧的进程内观测', async () => {
    const now = 5_000
    const ledger = new RateLimitLedger({ now: () => now })
    ledger.setPersistence({ load: async () => [resetObservation({ resetAtMs: 60_000, lastSeenAtMs: 4_000 })], save: async () => {} })
    ledger.record({ ...resetObservation({ resetAtMs: 60_000 }), lastSeenAtMs: 1_000 })
    await ledger.restore('workbuddy')
    expect(ledger.activeFor('workbuddy')?.lastSeenAtMs).toBe(4_000)
  })

  it('restoreAll 聚合多个 provider，单个失败只报告不中断', async () => {
    const onError = vi.fn()
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.setPersistence({
      load: async provider => {
        if (provider === 'zcode') throw new Error('read failed')
        return [resetObservation({ provider })]
      },
      save: async () => {},
    })
    await expect(ledger.restoreAll(['workbuddy', 'zcode', 'workbuddy-ai'], onError)).resolves.toBe(2)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(ledger.activesFor('workbuddy')).toHaveLength(1)
  })

  it('restoreAll：没有持久化时返回 0', async () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    await expect(ledger.restoreAll(['workbuddy'])).resolves.toBe(0)
  })

  it('attachRateLimitPersistence：落盘与恢复失败分别告警', async () => {
    const warn = vi.fn()
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    attachRateLimitPersistence(ledger, {
      load: async () => { throw new Error('read failed') },
      save: async () => { throw new Error('write failed') },
    }, ['workbuddy'], { warn })
    ledger.record(resetObservation())
    await ledger.flush()
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledTimes(2) }, { timeout: 5_000 })
    // 两条失败谁先落定不保证顺序，分别断言。
    const messages = warn.mock.calls.map(call => String(call[0]))
    expect(messages.some(message => message.includes('persistence failed'))).toBe(true)
    expect(messages.some(message => message.includes('restore failed'))).toBe(true)
  })

  it('attachRateLimitPersistence：没有 logger 时失败被静默吞掉', async () => {
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    attachRateLimitPersistence(ledger, {
      load: async () => { throw new Error('read failed') },
      save: async () => { throw new Error('write failed') },
    }, ['workbuddy'])
    ledger.record(resetObservation())
    await expect(ledger.flush()).resolves.toBeUndefined()
    // 让 restoreAll 的拒绝在宏任务里落定，确保没有 unhandled rejection。
    await new Promise(resolve => setImmediate(resolve))
  })

  it('落盘失败只报告，不影响观测与 flush', async () => {
    const onError = vi.fn()
    const ledger = new RateLimitLedger({ now: () => 1_000 })
    ledger.setPersistence({ load: async () => undefined, save: async () => { throw new Error('disk full') } }, onError)
    ledger.record(resetObservation())
    await expect(ledger.flush()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(ledger.activesFor('workbuddy')).toHaveLength(1)
  })
})
