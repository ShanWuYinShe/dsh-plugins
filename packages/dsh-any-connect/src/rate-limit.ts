/**
 * rate-limit.ts — 上游 429 限流观测台账。
 *
 * 为什么需要它：DSH 的模型通道把上游 429 折叠成一次失败的重试，用户只看到
 * 「请求失败」，看不到「还有多久能再用」。而各家上游对「多久恢复」的披露程度
 * 差别极大（实测见下表），所以这里只记录**上游真的告诉我们的事实**，绝不按
 * 固定窗口猜一个倒计时。
 *
 * 已确证的公开口径（2026-10-29 抓取官方文档，详见 README「限流」一节）：
 *
 * - OpenRouter：429 错误响应带 `X-RateLimit-Limit` / `X-RateLimit-Remaining` /
 *   `X-RateLimit-Reset`；当每个候选 provider 都给了重试提示时还带
 *   `Retry-After`（https://openrouter.ai/docs/api-reference/limits）。
 * - Kimi / Moonshot：超限返回 429，响应头带 `X-RateLimit-Limit` /
 *   `X-RateLimit-Remaining` / `X-RateLimit-Reset`（https://platform.kimi.com/docs/pricing/limits）。
 * - GLM Coding Plan（zcode）：**两种限制并存，必须分清**。
 *   1) 并发限流（错误码 1302「触发用户速率限制」/1305「平台服务过载」）：按订阅
 *      档位的并发数，且平台按资源动态调整，官方明确不给固定窗口
 *      （https://docs.bigmodel.cn/cn/api/rate-limit）；
 *   2) 积分额度（每 5 小时积分 + 每周积分）：5 小时积分**按消耗时刻滚动 5 小时**
 *      刷新，周积分自下单起 7 天一个周期
 *      （https://docs.bigmodel.cn/cn/coding-plan/overview）。
 *   第 2 类**有确定的恢复时刻**，但它走额度通道而不是 429——由
 *   zcode-quota.ts 的 `nextResetTime` 上报，与本模块的 `resetAt` 各管一段：
 *   本模块只管 429 这条通道，额度窗口的恢复时间由窗口自带的 `resetsAt` 表达。
 * - WorkBuddy / OpenCode 免费通道：没有公开的限流窗口文档，只有实测的
 *   FreeTierError 频次/并发风控（见 upstream-shared 的分类注释）。
 *
 * 因此本模块的契约是：`resetAt` 只来自上游响应头；拿不到就只报「何时被限」，
 * 让界面如实说「恢复时间未知」，而不是给一个会骗人的倒计时。
 *
 * @module dsh-any-connect/rate-limit
 */

/** 一次 429 观测，按 provider（变体 id）记录。 */
export interface RateLimitObservation {
  /** 变体 id，与 provider route 键一致（workbuddy / zcode / opencode-free …）。 */
  provider: string
  /** 首次观测到限流的时刻（毫秒 epoch）。持续被限时保留最早值，便于「已经等了多久」。 */
  blockedAtMs: number
  /** 最近一次观测到限流的时刻（毫秒 epoch）。 */
  lastSeenAtMs: number
  /**
   * 上游明示的恢复时刻（毫秒 epoch）。**只有**上游通过响应头给了才存在：
   * `Retry-After`（秒或 HTTP-date）、`X-RateLimit-Reset`（秒或毫秒 epoch）。
   * 拿不到就是 undefined——界面必须如实说「恢复时间未知」。
   */
  resetAtMs?: number
  /** 上游原始状态码（通常是 429；OpenCode FreeTierError 是 403）。 */
  status: number
  /** 分类结果，与 shim 的错误分类同源。 */
  kind: string
  /** 触发限流的具体模型 id（若能拿到），用于卡片里说清「哪个模型被限」。 */
  model?: string
  /** 观测次数：同一次限流期内每再撞一次 +1，用于区分「偶发」与「持续被限」。 */
  hits: number
}

/** 台账快照：按 provider 键的观测，以及给界面用的派生判断。 */
export interface RateLimitSnapshot {
  /** 当前仍在限流窗口内的观测（resetAtMs 已过或缺失但仍在 TTL 内）。 */
  active: readonly RateLimitObservation[]
  /** 全部观测（含已恢复的），按 lastSeenAtMs 倒序，供卡片展示历史。 */
  recent: readonly RateLimitObservation[]
}

/** 没有 `resetAtMs` 的观测保留多久：够用户看懂「刚才被限了」，又不会永远挂着。 */
export const DEFAULT_RATE_LIMIT_TTL_MS = 30 * 60 * 1000

/** 观测里允许出现的状态码：429 与 OpenCode FreeTierError 的 403。 */
const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 403])

/**
 * 解析上游给的重置时间，统一成毫秒 epoch。
 *
 * 只认三种实测形态，其余一律 undefined（不猜）：
 * - `Retry-After` 的秒数（纯数字，相对 now）；
 * - `Retry-After` 的 HTTP-date（绝对时刻）；
 * - `X-RateLimit-Reset` 的秒或毫秒 epoch（OpenRouter/Kimi 口径）。
 *
 * @param value - 响应头原文。
 * @param nowMs - 解析基准时刻（秒数形态是相对值）。
 * @returns 毫秒 epoch；无法可靠解析时为 undefined。
 */
export function parseResetHeader(value: string | null | undefined, nowMs: number): number | undefined {
  if (value === null || value === undefined) return undefined
  const text = value.trim()
  if (text === '') return undefined
  // 纯数字：可能是 Retry-After 的相对秒，也可能是 X-RateLimit-Reset 的 epoch。
  // 用数量级区分——epoch 秒在 2001 年就超过 1e9，而相对秒数不可能那么大
  // （>31 年）。这条界线让同一个解析器对两种头都成立。
  if (/^\d+(?:\.\d+)?$/u.test(text)) {
    const n = Number(text)
    if (!Number.isFinite(n) || n < 0) return undefined
    if (n >= 1e12) return n // 毫秒 epoch
    if (n >= 1e9) return n * 1000 // 秒 epoch
    return nowMs + n * 1000 // 相对秒
  }
  // 只有形如 HTTP-date 的文本才交给 Date.parse：它对 "−5"、"12" 这类输入
  // 会给出 2001 年之类的离谱结果（V8 把裸数字当 year），而重置时刻写成负数
  // 或裸年份是上游的畸形输出，不能当事实用。
  if (!/[a-z]{3}/iu.test(text)) return undefined
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) return undefined
  // 过去超过一天的时刻不是「重置时刻」（上游时钟漂移容忍在内）：拿它做倒计时
  // 只会显示一个早已过去的瞬间。
  if (parsed < nowMs - 86_400_000) return undefined
  return parsed
}

/**
 * 从一次失败响应里抽取限流观测；不是限流就返回 undefined。
 *
 * 判定依据是**状态码 + 分类**，不是文案匹配：上游文案随时会改，而
 * `classifyUpstreamError` 已经把 429 与 FreeTierError 归到 soft_rate。
 *
 * @param input - 一次失败响应的可观测面。
 * @returns 新观测，或 undefined（非限流）。
 */
export function observeRateLimit(input: {
  provider: string
  status: number
  kind: string
  model?: string
  headers?: { get(name: string): string | null }
  nowMs?: number
}): RateLimitObservation | undefined {
  const nowMs = input.nowMs ?? Date.now()
  const isRate = input.kind === 'soft_rate' || RATE_LIMIT_STATUSES.has(input.status)
  if (!isRate) return undefined
  // soft_rate 之外的状态码不算限流（例如 500 也被某些上游说成「稍后重试」，
  // 但那是服务端故障，不是额度节奏）。
  if (input.kind !== 'soft_rate' && !RATE_LIMIT_STATUSES.has(input.status)) return undefined
  const resetAtMs = parseResetHeader(input.headers?.get('retry-after'), nowMs)
    ?? parseResetHeader(input.headers?.get('x-ratelimit-reset'), nowMs)
  return {
    provider: input.provider,
    blockedAtMs: nowMs,
    lastSeenAtMs: nowMs,
    ...resetAtMs === undefined ? {} : { resetAtMs },
    status: input.status,
    kind: input.kind,
    ...input.model === undefined || input.model === '' ? {} : { model: input.model },
    hits: 1,
  }
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
 * 内存台账：按 provider 合并同一段限流期，并派生界面需要的视图。
 *
 * 合并规则：同一 provider 在「仍处于限流中」时再次撞到限流，视为同一次持续
 * 限流——保留最早的 `blockedAtMs`（用户想知道「等了多久」）、刷新
 * `lastSeenAtMs` 与 `hits`、用最新的 `resetAtMs` 覆盖（上游每次都会给更准的值）。
 * 一旦上一次已过期，就是新的一段限流，重新计时。
 */
export class RateLimitLedger {
  private readonly observations = new Map<string, RateLimitObservation>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_RATE_LIMIT_TTL_MS
    this.now = options.now ?? Date.now
  }

  /**
   * 记录一次限流观测。
   *
   * @param observation - {@link observeRateLimit} 的结果。
   * @returns 合并后的当前观测（调用方一般不需要它）。
   */
  record(observation: RateLimitObservation): RateLimitObservation {
    const now = this.now()
    const previous = this.observations.get(observation.provider)
    const merged: RateLimitObservation = previous !== undefined && isRateLimitActive(previous, now, this.ttlMs)
      ? {
          ...observation,
          blockedAtMs: previous.blockedAtMs,
          hits: previous.hits + 1,
          ...observation.resetAtMs === undefined && previous.resetAtMs !== undefined
            ? { resetAtMs: previous.resetAtMs }
            : {},
        }
      : observation
    this.observations.set(merged.provider, merged)
    return merged
  }

  /** 清掉某 provider 的观测（例如一次成功请求证明限流已解除）。 */
  clear(provider: string): void {
    this.observations.delete(provider)
  }

  /**
   * 当前视图。`active` 只含仍在限流中的观测，`recent` 是全部未过期的。
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

  /** 单个 provider 的活跃观测，没有则 undefined。 */
  activeFor(provider: string): RateLimitObservation | undefined {
    return this.snapshot(provider).active[0]
  }
}
