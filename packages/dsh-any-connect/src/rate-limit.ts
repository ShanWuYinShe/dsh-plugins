/**
 * rate-limit.ts — 上游 429 限流观测台账（策略感知）。
 *
 * 为什么需要它：DSH 的模型通道把上游 429 折叠成一次失败的重试，用户只看到
 * 「请求失败」，看不到「还有多久能再用」。而各家上游对「多久恢复」的披露程度
 * 差别极大，所以这里只记录**上游真的告诉我们的事实**，绝不按固定窗口猜倒计时。
 *
 * 已确证/采用的公开口径（详见 README「上游限流」一节）：
 *
 * - IETF RateLimit / RateLimit-Policy（draft-ietf-httpapi-ratelimit-headers-11，
 *   仍是 Internet-Draft）：RateLimit-Policy: "default";q=100;w=60（配额 + 窗口
 *   秒数），RateLimit: "default";r=0;t=30（剩余 + delta 秒恢复时刻）。注意 t 是
 *   相对秒，不是 epoch——与 X-RateLimit-Reset 的语义严格区分。
 * - OpenRouter / Kimi：429 带 X-RateLimit-Limit / -Remaining / -Reset（epoch 秒，
 *   本模块同时兼容毫秒），有重试提示时也带 Retry-After。
 * - OpenAI 风格：x-ratelimit-limit-* / -remaining-* / -reset-*，reset 是时长字符串
 *   （如 1s、6m0s）。
 * - Anthropic 风格：anthropic-ratelimit-<metric>-limit|remaining|reset，reset 是
 *   RFC3339 绝对时刻。
 * - 旧版 IETF 草案独立头：RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset
 *   （delta 秒）。
 * - GLM Coding Plan（zcode）：并发限流（1302/1305）按订阅档位动态调整、官方明确
 *   不给固定窗口；积分额度走额度通道（窗口自带 resetsAt），与本模块各管一段。
 * - WorkBuddy / OpenCode 免费通道：WorkBuddy 的限流**按模型**（官方客户端把
 *   cap-hit 以 modelId 为键落盘，code:6004，恢复时刻写在错误正文里，省略时区按
 *   UTC+8）；OpenCode 的 FreeUsageLimitError（429）带 Retry-After，FreeTierError
 *   （403）不带恢复时刻。
 *
 * 契约：resetAt 只来自上游**明说**的事实（标准/事实头或错误正文里的显式时刻）。
 * 两者都没有就只报「何时被限」，让界面如实说「恢复时间未知」，而不是编一个会
 * 骗人的倒计时。
 *
 * 台账只记录、**绝不拦截**：它不参与任何请求门禁，请求是否放行完全由上游决定；
 * 一次成功请求只清掉对应模型的观测。
 *
 * 策略感知：一条观测可携带 policy / scope / metric / limit / remaining /
 * windowSeconds（上游给出时才有），台账行键是 provider + model + policy——同一
 * 模型可能同时被 RPM、TPM、日额度等多条策略约束，分别记录、分别展示，不再把
 * 多条策略合并成一条含糊的「被限了」。
 *
 * 持久化：带明确 resetAt 的观测经注入的 RateLimitPersistence 落盘
 * （storageDomain），DSH 重启后继续提示；没有 reset 的观测只活在本进程的 TTL 里。
 *
 * @module dsh-any-connect/rate-limit
 */

/** 限流的归属范围：按模型，还是账号/通道级（上游没给模型维度时）。 */
export type RateLimitScope = 'model' | 'account'

/**
 * 一次 429 观测。
 *
 * WorkBuddy 一家就按模型限流：同一个 provider 下 A 模型被限时 B 模型仍可用，
 * 因此台账的行级键是 provider + model (+ policy)，而不是整个 provider 一条。
 */
export interface RateLimitObservation {
  /** 变体 id，与 provider route 键一致（workbuddy / zcode / opencode-free 等）。 */
  provider: string
  /** 首次观测到限流的时刻（毫秒 epoch）。持续被限时保留最早值，便于「等了多久」。 */
  blockedAtMs: number
  /** 最近一次观测到限流的时刻（毫秒 epoch）。 */
  lastSeenAtMs: number
  /**
   * 上游明示的恢复时刻（毫秒 epoch）。**只有**上游真的说了才存在：
   * Retry-After（RFC 9110：秒或 HTTP-date）、IETF RateLimit 的 t（delta 秒）、
   * 旧版 RateLimit-Reset（delta 秒）、X-RateLimit-Reset（epoch 秒/毫秒）、厂商头
   * （OpenAI 时长串 / Anthropic RFC3339），或错误正文里的时刻。拿不到就是
   * undefined——界面必须如实说「恢复时间未知」。
   */
  resetAtMs?: number
  /** 上游原始状态码（通常是 429；OpenCode FreeTierError 是 403）。 */
  status: number
  /** 分类结果，与 shim 的错误分类同源。 */
  kind: string
  /** 触发限流的具体模型 id（若能拿到），用于卡片里说清「哪个模型被限」。 */
  model?: string
  /** 策略/限额名（IETF 头里的 policy 名、厂商头里的 metric 名；未命名时缺席）。 */
  policy?: string
  /** 归属范围：有模型为 model，无模型（上游没给维度）为 account。 */
  scope?: RateLimitScope
  /** 计量维度（requests / tokens / input-tokens / output-tokens 等）。 */
  metric?: string
  /** 该策略声明的配额上限（上游给出时才有）。 */
  limit?: number
  /** 观测时的剩余额度（上游给出时才有；通常为 0 才能解释这次拒绝）。 */
  remaining?: number
  /** 策略窗口长度（秒，上游给出时才有）。 */
  windowSeconds?: number
  /** 观测次数：同一次限流期内每再撞一次 +1，用于区分「偶发」与「持续被限」。 */
  hits: number
}

/** 台账快照：按 provider+model+policy 键的观测，以及给界面用的派生判断。 */
export interface RateLimitSnapshot {
  /** 当前仍在限流窗口内的观测（resetAtMs 已过或缺失但仍在 TTL 内）。 */
  active: readonly RateLimitObservation[]
  /** 全部未过期的观测，按 lastSeenAtMs 倒序，供卡片展示历史。 */
  recent: readonly RateLimitObservation[]
}

/**
 * 活跃观测的持久化接口（storageDomain 实现与测试替身共用）。
 *
 * 只持久化带明确 resetAtMs 的观测：没有 reset 的观测是「本进程刚刚看到」的
 * 事实，按 TTL 过期；重启后还挂着一条没有恢复时刻的旧观测没有意义。
 */
export interface RateLimitPersistence {
  load(provider: string): Promise<readonly RateLimitObservation[] | undefined>
  save(provider: string, observations: readonly RateLimitObservation[]): Promise<void>
}

/** 观测持久化层的最小日志面（宿主 ctx.logger 与之结构兼容）。 */
export interface RateLimitLogger {
  warn?(message: string, error: unknown): void
}

/** 没有 resetAtMs 的观测保留多久：够用户看懂「刚才被限了」，又不会永远挂着。 */
export const DEFAULT_RATE_LIMIT_TTL_MS = 30 * 60 * 1000

/** 观测里允许出现的状态码：429 与 OpenCode FreeTierError 的 403。 */
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 403])

/** 单 provider 最多持久化的观测条数：一份记录保持很小，足够覆盖一个渠道的活跃策略。 */
const MAX_PERSISTED_OBSERVATIONS = 64

/** 数字形态（整数或小数，非负）。 */
const NUMBER_TEXT = /^\d+(?:\.\d+)?$/u

/** HTTP-date 的形状提示：Date.parse 会把裸数字当 year，不能直接交给它。 */
const HTTP_DATE_HINT = /[a-z]{3}/iu

/** 过去超过一天的时刻不当作「恢复时刻」：拿它做倒计时只会显示一个已过去的瞬间。 */
const PAST_TOLERANCE_MS = 86_400_000

/** 把数字文本解析为有限非负数。 */
function numberOf(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (!NUMBER_TEXT.test(text)) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 把毫秒 epoch 收敛成可用值：过去超过容忍窗口的不用。 */
function acceptInstant(atMs: number, nowMs: number): number | undefined {
  return atMs < nowMs - PAST_TOLERANCE_MS ? undefined : atMs
}

/**
 * 解析 RFC 9110 的 Retry-After：delta-seconds（相对秒）或 HTTP-date（绝对时刻）。
 *
 * @param value - 响应头原文。
 * @param nowMs - 解析基准时刻。
 * @returns 毫秒 epoch；无法可靠解析时为 undefined（绝不猜）。
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (text === '') return undefined
  const seconds = numberOf(text)
  if (seconds !== undefined) return nowMs + seconds * 1000
  if (!HTTP_DATE_HINT.test(text)) return undefined
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) return undefined
  return acceptInstant(parsed, nowMs)
}

/**
 * 解析事实标准 X-RateLimit-Reset 的 epoch 形态（OpenRouter / Kimi：秒；部分实现
 * 给毫秒）。注意：**不能**把小数字当 delta 秒——那是 RateLimit-Reset 的语义；
 * 本函数只接受 epoch 量级，小于 1e9 的数字返回 undefined（不猜）。
 *
 * @param value - 响应头原文。
 * @param nowMs - 解析基准时刻。
 * @returns 毫秒 epoch；不是 epoch 量级或已过去太久时为 undefined。
 */
export function parseEpochReset(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (text === '') return undefined
  const numeric = numberOf(text)
  if (numeric === undefined) return undefined
  // epoch 秒在 2001 年就超过 1e9；epoch 毫秒在 1e12 量级。
  const atMs = numeric >= 1e12 ? numeric : numeric >= 1e9 ? numeric * 1000 : undefined
  if (atMs === undefined) return undefined
  return acceptInstant(atMs, nowMs)
}

/**
 * 解析 delta-seconds 形态的恢复时间（旧版 RateLimit-Reset / IETF RateLimit 的 t）。
 *
 * @param value - 数字文本（相对秒）。
 * @param nowMs - 解析基准时刻。
 * @returns 毫秒 epoch；非数字或为负时为 undefined。
 */
export function parseDeltaSeconds(value: string | null | undefined, nowMs: number): number | undefined {
  const seconds = numberOf(value)
  return seconds === undefined ? undefined : nowMs + seconds * 1000
}

/**
 * 解析时长文本（OpenAI 的 x-ratelimit-reset-* 形态：1s / 6m0s / 500ms / 1h2m3s）。
 *
 * @param value - 响应头原文；纯数字按秒解释。
 * @returns 毫秒时长；无法解析时为 undefined。
 */
export function parseDurationMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim().toLowerCase()
  if (text === '') return undefined
  const plain = numberOf(text)
  if (plain !== undefined) return plain * 1000
  // 正则只接受 h/m/s/ms 四种单位，因此查表结果必然存在（缺省不会发生）。
  const unitMs: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/gu
  let total = 0
  let consumed = 0
  let matched = false
  for (const match of text.matchAll(pattern)) {
    const amount = Number(match[1])
    // 超长数字会解析成 Infinity：那不是上游写出的时长。
    if (!Number.isFinite(amount)) return undefined
    total += amount * (unitMs[match[2] as string] as number)
    consumed += match[0].length
    matched = true
  }
  // 必须整段消费：1s junk 这类畸形值不猜。
  return matched && consumed === text.length ? total : undefined
}

/** 结构化字段列表里的一个成员（RFC 8941 子集：具名 item + 数字/字符串参数）。 */
interface StructuredItem {
  name?: string
  params: Map<string, number | string>
}

/** 按顶层逗号切分结构化字段的 List（忽略引号内的逗号与转义）。 */
function splitStructuredList(text: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (quoted && char === '\\') {
      current += char
      const next = text[index + 1]
      if (next !== undefined) {
        current += next
        index += 1
      }
      continue
    }
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (char === ',' && !quoted) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/** 解析一个结构化字段成员：可选带引号名称 + 分号分隔的 key=value 参数。 */
function parseStructuredItem(raw: string): StructuredItem | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const segments: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (quoted && char === '\\') {
      current += char
      const next = text[index + 1]
      if (next !== undefined) {
        current += next
        index += 1
      }
      continue
    }
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (char === ';' && !quoted) {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  const [nameSegment, ...paramSegments] = segments
  let name: string | undefined
  const nameText = (nameSegment ?? '').trim()
  if (nameText.startsWith('"') && nameText.endsWith('"') && nameText.length >= 2) {
    name = nameText.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  } else if (nameText !== '' && !nameText.includes('=')) {
    name = nameText
  } else if (nameText.includes('=')) {
    paramSegments.unshift(nameText)
  }
  const params = new Map<string, number | string>()
  for (const segment of paramSegments) {
    const [key, ...rest] = segment.split('=')
    const rawValue = rest.join('=')
    const paramName = (key ?? '').trim()
    if (paramName === '' || rawValue === '') continue
    const valueText = rawValue.trim()
    const numeric = numberOf(valueText)
    params.set(paramName, numeric !== undefined ? numeric : valueText.replace(/^"|"$/gu, ''))
  }
  if (name === undefined && params.size === 0) return undefined
  return { ...name === undefined ? {} : { name }, params }
}

/** 解析整个结构化字段 List；非法时返回空数组（不抛错）。 */
function parseStructuredList(value: string | null | undefined): StructuredItem[] {
  if (value === null || value === undefined) return []
  const text = value.trim()
  if (text === '') return []
  const items: StructuredItem[] = []
  for (const part of splitStructuredList(text)) {
    const item = parseStructuredItem(part)
    if (item !== undefined) items.push(item)
  }
  return items
}

/** 从响应头读到的一条策略事实（可能来自标准头、厂商头或旧版独立头）。 */
export interface RateLimitPolicyFact {
  policy?: string
  resetAtMs?: number
  limit?: number
  remaining?: number
  windowSeconds?: number
  metric?: string
}

/** 读取参数里的非负数字（负数与非法值一律视为未提供）。 */
function paramNumber(item: StructuredItem | undefined, key: string): number | undefined {
  const value = item?.params.get(key)
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 数字头：值为有限非负数时返回。 */
function numericHeader(headers: { get(name: string): string | null }, name: string): number | undefined {
  return numberOf(headers.get(name))
}

/** 厂商头里的 metric 对：OpenAI 风格（reset 是时长串）与 Anthropic 风格（RFC3339）。 */
interface MetricHeaderGroup {
  metric: string
  limit: string
  remaining: string
  reset: string
  resetKind: 'duration' | 'instant'
}

const METRIC_HEADER_GROUPS: readonly MetricHeaderGroup[] = [
  { metric: 'requests', limit: 'x-ratelimit-limit-requests', remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests', resetKind: 'duration' },
  { metric: 'tokens', limit: 'x-ratelimit-limit-tokens', remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens', resetKind: 'duration' },
  { metric: 'requests', limit: 'anthropic-ratelimit-requests-limit', remaining: 'anthropic-ratelimit-requests-remaining', reset: 'anthropic-ratelimit-requests-reset', resetKind: 'instant' },
  { metric: 'input-tokens', limit: 'anthropic-ratelimit-input-tokens-limit', remaining: 'anthropic-ratelimit-input-tokens-remaining', reset: 'anthropic-ratelimit-input-tokens-reset', resetKind: 'instant' },
  { metric: 'output-tokens', limit: 'anthropic-ratelimit-output-tokens-limit', remaining: 'anthropic-ratelimit-output-tokens-remaining', reset: 'anthropic-ratelimit-output-tokens-reset', resetKind: 'instant' },
  { metric: 'tokens', limit: 'anthropic-ratelimit-tokens-limit', remaining: 'anthropic-ratelimit-tokens-remaining', reset: 'anthropic-ratelimit-tokens-reset', resetKind: 'instant' },
]

/** 厂商 metric 头的 reset 值解析成毫秒 epoch。 */
function metricResetAt(group: MetricHeaderGroup, value: string | null, nowMs: number): number | undefined {
  if (group.resetKind === 'duration') {
    const duration = parseDurationMs(value)
    return duration === undefined ? undefined : nowMs + duration
  }
  if (value === null) return undefined
  const instant = Date.parse(value)
  return Number.isNaN(instant) ? undefined : instant
}

/**
 * 从 429 响应头解析限流策略事实。
 *
 * 优先级（避免同一响应被多种头重复计数）：
 * 1. IETF RateLimit / RateLimit-Policy（标准，t/w 是 delta 秒）；
 * 2. 厂商 metric 对（OpenAI / Anthropic 风格，只在 remaining === 0 时采信——只有
 *    它为 0 才能解释这次拒绝）；
 * 3. 旧版独立头 RateLimit-Limit / Remaining / Reset（delta 秒）。
 *
 * @param headers - 上游响应头读取面。
 * @param nowMs - 解析基准时刻（t/Reset 是相对值）。
 * @returns 策略事实数组；没有任何可采信的头时为空数组。
 */
export function parseRateLimitPolicies(
  headers: { get(name: string): string | null } | undefined,
  nowMs: number,
): readonly RateLimitPolicyFact[] {
  if (headers === undefined) return []
  const policyItems = parseStructuredList(headers.get('ratelimit-policy'))
  const rateItems = parseStructuredList(headers.get('ratelimit'))
  const facts: RateLimitPolicyFact[] = []
  for (const rateItem of rateItems) {
    const name = rateItem.name
    const policyItem = name === undefined
      ? policyItems.length === 1 ? policyItems[0] : undefined
      : policyItems.find(item => item.name === name)
    const remaining = paramNumber(rateItem, 'r')
    const deltaSeconds = paramNumber(rateItem, 't')
    const limit = paramNumber(policyItem, 'q')
    // 窗口长度必须为正；0 秒窗口没有意义，视为未提供。
    const windowParam = paramNumber(policyItem, 'w')
    const windowSeconds = windowParam !== undefined && windowParam > 0 ? windowParam : undefined
    if (remaining === undefined && deltaSeconds === undefined && limit === undefined && windowSeconds === undefined) continue
    facts.push({
      ...name === undefined ? {} : { policy: name },
      ...deltaSeconds === undefined ? {} : { resetAtMs: nowMs + deltaSeconds * 1000 },
      ...remaining === undefined ? {} : { remaining },
      ...limit === undefined ? {} : { limit },
      ...windowSeconds === undefined ? {} : { windowSeconds },
    })
  }
  if (facts.length > 0) return facts

  for (const group of METRIC_HEADER_GROUPS) {
    const remaining = numericHeader(headers, group.remaining)
    // 只有「余量确实为 0」的策略才解释得通这次 429；余量未知/仍为正的跳过。
    if (remaining !== 0) continue
    const resetAtMs = metricResetAt(group, headers.get(group.reset), nowMs)
    const limit = numericHeader(headers, group.limit)
    facts.push({
      policy: group.metric,
      metric: group.metric,
      remaining,
      ...limit === undefined ? {} : { limit },
      ...resetAtMs === undefined ? {} : { resetAtMs },
    })
  }
  if (facts.length > 0) return facts

  const legacyLimit = numericHeader(headers, 'ratelimit-limit')
  const legacyRemaining = numericHeader(headers, 'ratelimit-remaining')
  const legacyReset = parseDeltaSeconds(headers.get('ratelimit-reset'), nowMs)
  if (legacyLimit === undefined && legacyRemaining === undefined && legacyReset === undefined) return []
  return [{
    ...legacyLimit === undefined ? {} : { limit: legacyLimit },
    ...legacyRemaining === undefined ? {} : { remaining: legacyRemaining },
    ...legacyReset === undefined ? {} : { resetAtMs: legacyReset },
  }]
}

/**
 * 响应头里的恢复时刻（用于聊天错误提示）：策略事实优先，其次 Retry-After、
 * X-RateLimit-Reset，最后厂商头里的 reset。
 *
 * @param headers - 上游响应头读取面。
 * @param nowMs - 解析基准时刻。
 * @returns 毫秒 epoch；没有任何头时 undefined。
 */
export function resolveHeaderResetAt(
  headers: { get(name: string): string | null } | undefined,
  nowMs: number,
): number | undefined {
  if (headers === undefined) return undefined
  const policyResets = parseRateLimitPolicies(headers, nowMs)
    .map(fact => fact.resetAtMs)
    .filter((value): value is number => value !== undefined)
    .sort((left, right) => left - right)
  const [firstPolicyReset] = policyResets
  if (firstPolicyReset !== undefined) return firstPolicyReset
  const retryAfter = parseRetryAfter(headers.get('retry-after'), nowMs)
  if (retryAfter !== undefined) return retryAfter
  const epochReset = parseEpochReset(headers.get('x-ratelimit-reset'), nowMs)
  if (epochReset !== undefined) return epochReset
  // 少数实现把 X-RateLimit-Reset 写成 delta 秒（小数字）；epoch 量级之外按它解析。
  const deltaReset = parseDeltaSeconds(headers.get('x-ratelimit-reset'), nowMs)
  if (deltaReset !== undefined) return deltaReset
  // 厂商头里余量仍为正、没进策略事实的 reset 也作为提示可用。
  for (const group of METRIC_HEADER_GROUPS) {
    const resetAtMs = metricResetAt(group, headers.get(group.reset), nowMs)
    if (resetAtMs !== undefined) return resetAtMs
  }
  return undefined
}

/** 错误正文里的时刻：YYYY-MM-DD HH:mm:ss，日期与时间之间允许空格或 T。 */
const RESET_TIMESTAMP = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/gu

/** 时刻后缀的显式时区：UTC+8 / UTC+08:00 / GMT-5 / (UTC+8)。 */
const RESET_UTC_OFFSET = /^\s*\(?\s*(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\s*\)?/iu

/** 时刻后缀的 ISO 偏移：+08:00 / +0800。 */
const RESET_ISO_OFFSET = /^\s*\(?\s*([+-])(\d{2}):?(\d{2})\s*\)?/u

/** 恢复类关键词：正文里出现多个时刻时，用它挑出「恢复时刻」那一个。 */
const RESET_KEYWORD = /reset|resets|重置|恢复|刷新/iu

/**
 * 正文时刻省略时区时的默认解释：UTC+8（上海壁钟）。
 *
 * 这是 WorkBuddy 官方客户端自己的口径——它的解析正则把 UTC+8 当可选后缀，缺失时
 * 直接按 UTC+8 反解。本模块对齐这一口径；调用方仍可通过 options 覆盖。
 */
export const DEFAULT_BARE_WALL_CLOCK_OFFSET_MINUTES = 8 * 60

/**
 * 把一个「壁钟时刻 + 时区偏移」换算成毫秒 epoch，并做日历回滚与过去时刻校验。
 *
 * @param parts - 正文里读到的年月日时分秒。
 * @param offsetMinutes - 时区偏移分钟数（东八区为 +480）。
 * @param nowMs - 解析基准时刻（过去超过一天的场合直接拒绝）。
 * @returns 毫秒 epoch；字段非法或日期不存在时为 undefined。
 */
function resetEpochFromParts(
  parts: { year: number, month: number, day: number, hour: number, minute: number, second: number },
  offsetMinutes: number,
  nowMs: number,
): number | undefined {
  const { year, month, day, hour, minute, second } = parts
  const offsetMs = offsetMinutes * 60_000
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs
  // 日历回滚校验：2 月 30 日会被 Date.UTC 顺延成 3 月 2 日，那不是上游写的时刻。
  const check = new Date(utcMs + offsetMs)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    return undefined
  }
  return acceptInstant(utcMs, nowMs)
}

/** 读正文时刻后面的显式时区偏移（分钟）；没有则 undefined。 */
function offsetAfter(text: string): number | undefined {
  const utc = RESET_UTC_OFFSET.exec(text)
  if (utc !== null) {
    const sign = utc[1] === '-' ? -1 : 1
    const hours = Number(utc[2])
    const minutes = utc[3] === undefined ? 0 : Number(utc[3])
    return sign * (hours * 60 + minutes)
  }
  const iso = RESET_ISO_OFFSET.exec(text)
  if (iso !== null) {
    const sign = iso[1] === '-' ? -1 : 1
    return sign * (Number(iso[2]) * 60 + Number(iso[3]))
  }
  return undefined
}

/**
 * 解析上游错误正文里的恢复时刻。
 *
 * @param value - 错误正文原文。
 * @param nowMs - 解析基准时刻（无时区后缀时按 UTC+8 反解，过去超过一天拒绝）。
 * @param options - bareWallClockOffsetMinutes 可覆盖省略时区时的解释（默认 +480）。
 * @returns 毫秒 epoch；正文没有可解析时刻时 undefined。
 */
export function parseResetMessage(
  value: string | null | undefined,
  nowMs: number,
  options: { bareWallClockOffsetMinutes?: number } = {},
): number | undefined {
  if (value === null || value === undefined) return undefined
  const bareOffset = options.bareWallClockOffsetMinutes ?? DEFAULT_BARE_WALL_CLOCK_OFFSET_MINUTES
  const candidates: { atMs: number, index: number }[] = []
  RESET_TIMESTAMP.lastIndex = 0
  for (const match of value.matchAll(RESET_TIMESTAMP)) {
    const [whole, year, month, day, hour, minute, second] = match
    const parts = {
      year: Number(year), month: Number(month), day: Number(day),
      hour: Number(hour), minute: Number(minute), second: Number(second),
    }
    const after = value.slice((match.index ?? 0) + whole.length)
    const offset = offsetAfter(after) ?? bareOffset
    // 字段来自固定正则、日历回滚由 resetEpochFromParts 内部校验；这里只收敛
    // 「过去太久」这一种不可用结果。
    const atMs = resetEpochFromParts(parts, offset, nowMs)
    if (atMs !== undefined) candidates.push({ atMs, index: match.index ?? 0 })
  }
  const [first] = candidates
  if (first === undefined) return undefined
  if (candidates.length === 1) return first.atMs
  const keyword = RESET_KEYWORD.exec(value)
  if (keyword === null) return first.atMs
  let best = first
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.index - keyword.index)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best.atMs
}

/**
 * 从一次失败响应里抽取限流观测（策略感知，可能一次响应多条策略）。
 *
 * 判定依据是**状态码 + 分类**，不是文案匹配：上游文案随时会改，而
 * classifyUpstreamError 已经把 429 与 FreeTierError 归到 soft_rate。
 *
 * @param input - 一次失败响应的可观测面。
 * @returns 观测数组；非限流时为空数组。
 */
export function observeRateLimits(input: {
  provider: string
  status: number
  kind: string
  model?: string
  headers?: { get(name: string): string | null }
  /** 上游错误体原文：部分上游把恢复时刻写在文案里而不是响应头。 */
  body?: string
  nowMs?: number
}): readonly RateLimitObservation[] {
  const nowMs = input.nowMs ?? Date.now()
  const isRate = input.kind === 'soft_rate' || RATE_LIMIT_STATUSES.has(input.status)
  // soft_rate 之外的状态码不算限流（例如 500 也被某些上游说成「稍后重试」，
  // 但那是服务端故障，不是额度节奏）。
  if (!isRate) return []
  const model = input.model === undefined || input.model === '' ? undefined : input.model
  const base: Omit<RateLimitObservation, 'hits'> = {
    provider: input.provider,
    blockedAtMs: nowMs,
    lastSeenAtMs: nowMs,
    status: input.status,
    kind: input.kind,
    ...model === undefined ? {} : { model },
    scope: model === undefined ? 'account' : 'model',
  }
  const facts = parseRateLimitPolicies(input.headers, nowMs)
  // 兜底恢复时刻：头里任何可用的事实（策略头 -> Retry-After -> epoch -> 厂商头），
  // 再退到错误正文里明写的时刻。
  const fallbackReset = resolveHeaderResetAt(input.headers, nowMs) ?? parseResetMessage(input.body, nowMs)
  if (facts.length === 0) {
    return [{ ...base, ...fallbackReset === undefined ? {} : { resetAtMs: fallbackReset }, hits: 1 }]
  }
  const seen = new Set<string>()
  const observations: RateLimitObservation[] = []
  for (const fact of facts) {
    const key = fact.policy ?? ''
    if (seen.has(key)) continue
    seen.add(key)
    const resetAtMs = fact.resetAtMs ?? fallbackReset
    observations.push({
      ...base,
      ...fact.policy === undefined ? {} : { policy: fact.policy },
      ...fact.metric === undefined ? {} : { metric: fact.metric },
      ...fact.limit === undefined ? {} : { limit: fact.limit },
      ...fact.remaining === undefined ? {} : { remaining: fact.remaining },
      ...fact.windowSeconds === undefined ? {} : { windowSeconds: fact.windowSeconds },
      ...resetAtMs === undefined ? {} : { resetAtMs },
      hits: 1,
    })
  }
  return observations
}

/** 一条观测是否仍处于限流中（有明确 reset 就按它，没有就按 TTL）。 */
export function isRateLimitActive(
  observation: RateLimitObservation,
  nowMs: number,
  ttlMs: number = DEFAULT_RATE_LIMIT_TTL_MS,
): boolean {
  if (observation.resetAtMs !== undefined) return observation.resetAtMs > nowMs
  return nowMs - observation.lastSeenAtMs < ttlMs
}

/**
 * 台账行键：provider + 模型 + 策略。
 *
 * 模型缺省代表「上游没告诉我们哪个模型」的 provider 级观测（例如传输层只给了
 * 状态码）；策略缺省代表上游没给策略名（只有恢复时刻的那类观测）。
 *
 * @param provider - 变体 id。
 * @param model - 模型 id，未知时省略。
 * @param policy - 策略名，未知时省略。
 * @returns Map 键。
 */
function ledgerKey(provider: string, model: string | undefined, policy: string | undefined): string {
  return [provider, model ?? '', policy ?? ''].join('\u0000')
}

/** 某 provider 的全部行键前缀。 */
function providerPrefix(provider: string): string {
  return provider + '\u0000'
}

/** 某 provider + 模型的全部行键前缀。 */
function modelPrefix(provider: string, model: string): string {
  return provider + '\u0000' + model + '\u0000'
}

/**
 * 把状态域持久化挂到台账并恢复各 provider 的观测（状态域就绪时由插件入口调用）。
 *
 * 这是 entry（index.ts）唯一需要的一步接线：读写失败只告警，不抛错、不影响
 * 模型代理主链路（与凭据副本同口径）。
 *
 * @param ledger - 限流台账。
 * @param persistence - 存储实现（storageDomain 的 rate_limits 表）。
 * @param providers - 需要恢复的变体 id 列表。
 * @param logger - 可选日志面；缺席时错误被静默吞掉（仅观测用途）。
 */
export function attachRateLimitPersistence(
  ledger: RateLimitLedger,
  persistence: RateLimitPersistence,
  providers: readonly string[],
  logger?: RateLimitLogger,
): void {
  ledger.setPersistence(persistence, error => {
    logger?.warn?.('dsh-any-connect: rate-limit persistence failed', error)
  })
  void ledger.restoreAll(providers, error => {
    logger?.warn?.('dsh-any-connect: rate-limit restore failed', error)
  })
}

/**
 * 内存台账：按 provider+model+policy 合并同一段限流期，并派生界面需要的视图。
 *
 * 合并规则：同一行在「仍处于限流中」时再次撞到限流，视为同一次持续限流——
 * 保留最早的 blockedAtMs（用户想知道「等了多久」）、刷新 lastSeenAtMs 与 hits、
 * 用最新的 resetAtMs 覆盖（上游每次都会给更准的值）。一旦上一次已过期，就是新
 * 的一段限流，重新计时。
 *
 * **只观测、不拦截**：任何请求都不会因为台账里有活跃观测而被拒绝，是否放行
 * 完全由上游决定；一次成功请求只清掉它自己那个模型的观测。
 *
 * 持久化：注入 RateLimitPersistence 后，带明确 resetAtMs 的观测会在每次变更后
 * 异步落盘（按 provider 串行、错误只报告不抛）；flush() 供卸载时等待。
 */
export class RateLimitLedger {
  private readonly observations = new Map<string, RateLimitObservation>()
  private readonly ttlMs: number
  private readonly now: () => number
  private persistence: RateLimitPersistence | undefined
  private onPersistenceError: ((error: unknown) => void) | undefined
  private readonly pending = new Map<string, Promise<void>>()

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_RATE_LIMIT_TTL_MS
    this.now = options.now ?? Date.now
  }

  /**
   * 注入持久化（状态域就绪后调用）。注入前后行为一致，只是多一次落盘。
   *
   * @param persistence - 存储实现。
   * @param onError - 落盘失败回调（只报告，不影响观测与主链路）。
   */
  setPersistence(persistence: RateLimitPersistence, onError?: (error: unknown) => void): void {
    this.persistence = persistence
    this.onPersistenceError = onError
  }

  /**
   * 从持久化恢复某 provider 的观测（只恢复仍活跃且带 resetAt 的条目）。
   *
   * @param provider - 变体 id。
   * @returns 恢复条数。
   */
  async restore(provider: string): Promise<number> {
    if (this.persistence === undefined) return 0
    const saved = await this.persistence.load(provider)
    if (saved === undefined) return 0
    const now = this.now()
    let restored = 0
    for (const observation of saved) {
      if (observation.resetAtMs === undefined) continue
      if (!isRateLimitActive(observation, now, this.ttlMs)) continue
      const key = ledgerKey(provider, observation.model, observation.policy)
      const inProcess = this.observations.get(key)
      // 注入窗口内本进程已记录过同一行时，不能拿旧快照覆盖更新鲜的观测。
      if (inProcess !== undefined && inProcess.lastSeenAtMs >= observation.lastSeenAtMs) continue
      this.observations.set(key, { ...observation, provider })
      restored += 1
    }
    return restored
  }

  /**
   * 恢复多个 provider 的观测（状态域就绪时一次调用）。
   *
   * 单个 provider 的持久化读失败只报告、不中断：持久化层故障不能让插件主链路
   * 或其它 provider 的恢复一起失败。
   *
   * @param providers - 变体 id 列表。
   * @param onError - 失败回调（每个 provider 一次）。
   * @returns 成功恢复的观测条数。
   */
  async restoreAll(providers: readonly string[], onError?: (error: unknown) => void): Promise<number> {
    let restored = 0
    for (const provider of providers) {
      try {
        restored += await this.restore(provider)
      } catch (error: unknown) {
        onError?.(error)
      }
    }
    return restored
  }

  /**
   * 记录一次限流观测。
   *
   * @param observation - observeRateLimits 的一条结果。
   * @returns 合并后的当前观测（调用方一般不需要它）。
   */
  record(observation: RateLimitObservation): RateLimitObservation {
    const now = this.now()
    const key = ledgerKey(observation.provider, observation.model, observation.policy)
    const previous = this.observations.get(key)
    let merged: RateLimitObservation
    if (previous !== undefined && isRateLimitActive(previous, now, this.ttlMs)) {
      const resetAtMs = observation.resetAtMs ?? previous.resetAtMs
      const limit = observation.limit ?? previous.limit
      const remaining = observation.remaining ?? previous.remaining
      const windowSeconds = observation.windowSeconds ?? previous.windowSeconds
      merged = {
        ...observation,
        blockedAtMs: previous.blockedAtMs,
        hits: previous.hits + 1,
        ...resetAtMs === undefined ? {} : { resetAtMs },
        ...limit === undefined ? {} : { limit },
        ...remaining === undefined ? {} : { remaining },
        ...windowSeconds === undefined ? {} : { windowSeconds },
      }
    } else {
      merged = observation
    }
    this.observations.set(key, merged)
    this.schedulePersist(observation.provider)
    return merged
  }

  /**
   * 清掉观测：一次成功请求只证明**它自己那个模型**的限流解除。
   *
   * 上游按模型限流时，B 模型成功不能拿来清 A 模型的观测（否则卡片会把还在限流
   * 的 A 误报成已恢复）。不传 model 时清该 provider 的全部观测——那是「整条通道
   * 都验证过」的口径，只给确实不分模型的场景用。
   *
   * @param provider - 变体 id。
   * @param model - 模型 id；省略表示清整个 provider。
   */
  clear(provider: string, model?: string): void {
    if (model !== undefined && model !== '') {
      const prefix = modelPrefix(provider, model)
      for (const key of [...this.observations.keys()]) {
        if (key.startsWith(prefix)) this.observations.delete(key)
      }
      // 同一次成功也说明渠道整体可用：把「模型未知」的 provider 级观测一并清掉。
      this.observations.delete(ledgerKey(provider, undefined, undefined))
      this.schedulePersist(provider)
      return
    }
    const prefix = providerPrefix(provider)
    for (const key of [...this.observations.keys()]) {
      if (key.startsWith(prefix)) this.observations.delete(key)
    }
    this.schedulePersist(provider)
  }

  /**
   * 当前视图。active 只含仍在限流中的观测，recent 是全部未过期的。
   *
   * @param provider - 只看某个 provider；省略则返回全部（卡片页用）。
   */
  snapshot(provider?: string): RateLimitSnapshot {
    const now = this.now()
    const all = [...this.observations.values()]
      .filter(entry => provider === undefined || entry.provider === provider)
      .filter(entry => now - entry.lastSeenAtMs < this.ttlMs || entry.resetAtMs !== undefined && entry.resetAtMs > now)
      .sort((left, right) => right.lastSeenAtMs - left.lastSeenAtMs)
    return {
      active: all.filter(entry => isRateLimitActive(entry, now, this.ttlMs)),
      recent: all,
    }
  }

  /** 该 provider 当前全部活跃观测（按最近被限时间倒序），卡片逐模型/逐策略展示。 */
  activesFor(provider: string): readonly RateLimitObservation[] {
    return this.snapshot(provider).active
  }

  /** 最近一次活跃观测，没有则 undefined（兼容旧调用）。 */
  activeFor(provider: string): RateLimitObservation | undefined {
    return this.snapshot(provider).active[0]
  }

  /** 等待所有在途落盘完成（卸载/测试收尾用）。错误已由 onError 报告，不会 reject。 */
  async flush(): Promise<void> {
    await Promise.all([...this.pending.values()])
  }

  /** 该 provider 需要持久化的观测：只有带明确重置时刻的才算「重启后仍成立的事实」。 */
  private persistableFor(provider: string): readonly RateLimitObservation[] {
    return this.snapshot(provider).recent
      .filter(entry => entry.resetAtMs !== undefined)
      .slice(0, MAX_PERSISTED_OBSERVATIONS)
  }

  /** 异步落盘；按 provider 串行，错误只报告。 */
  private schedulePersist(provider: string): void {
    if (this.persistence === undefined) return
    const persistence = this.persistence
    const previous = this.pending.get(provider) ?? Promise.resolve()
    const next = previous
      .then(() => persistence.save(provider, this.persistableFor(provider)))
      .catch((error: unknown) => {
        this.onPersistenceError?.(error)
      })
    this.pending.set(provider, next)
    void next.finally(() => {
      if (this.pending.get(provider) === next) this.pending.delete(provider)
    })
  }
}
