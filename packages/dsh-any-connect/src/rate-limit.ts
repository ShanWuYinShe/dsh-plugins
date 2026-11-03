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
 * - WorkBuddy / OpenCode 免费通道：没有公开的限流窗口文档。OpenCode 的
 *   FreeUsageLimitError（HTTP 429）在响应头带 `Retry-After`；FreeTierError
 *   （HTTP 403）是官方客户端形状校验，不带恢复时刻。
 *
 *   WorkBuddy（含 WorkBuddy AI）的限流是**按模型**的，不是整个 provider 共享：
 *   官方客户端把 cap-hit 以 modelId 为键落盘（`markCapHit(accountKey, modelId,
 *   resetAt)`），错误信封 `bizCode === 6004`，恢复时刻写在错误正文里，文案还会
 *   提示「或换其它模型继续」。官方客户端解析正文时用
 *   `/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*(?:UTC\+8|\(UTC\+8\)))?/`
 *   搜时刻，**省略时区时按 UTC+8（上海壁钟）解释**；本模块与该口径保持一致。
 *
 * 因此本模块的契约是：`resetAt` 来自上游**明说**的事实——响应头
 * （`Retry-After` / `X-RateLimit-Reset`）或错误正文里的显式时刻；正文时刻的
 * 时区后缀可省略（省略即 UTC+8，与 WorkBuddy 官方客户端同口径）。两者都没有
 * 就只报「何时被限」，让界面如实说「恢复时间未知」，而不是给一个会骗人的倒计时。
 *
 * 台账只记录、**绝不拦截**：它不参与任何请求门禁，请求是否放行完全由上游决定，
 * 一次成功请求只清掉对应模型的观测。
 *
 * @module dsh-any-connect/rate-limit
 */

/**
 * 一次 429 观测，按 provider（变体 id）+ 模型记录。
 *
 * WorkBuddy 一家就按模型限流：同一个 provider 下 A 模型被限时 B 模型仍可用，
 * 因此台账的行级键是 `provider + model`，而不是整个 provider 一条。
 */
export interface RateLimitObservation {
  /** 变体 id，与 provider route 键一致（workbuddy / zcode / opencode-free …）。 */
  provider: string
  /** 首次观测到限流的时刻（毫秒 epoch）。持续被限时保留最早值，便于「已经等了多久」。 */
  blockedAtMs: number
  /** 最近一次观测到限流的时刻（毫秒 epoch）。 */
  lastSeenAtMs: number
  /**
   * 上游明示的恢复时刻（毫秒 epoch）。**只有**上游真的说了才存在：
   * 响应头 `Retry-After`（秒或 HTTP-date）/ `X-RateLimit-Reset`（秒或毫秒 epoch），
   * 或错误正文里的时刻（如 WorkBuddy `usage will reset at 2026-10-30 14:20:02 UTC+8`，
   * 省略时区时按 UTC+8 解释，见 {@link parseResetMessage}）。
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

/** 台账快照：按 provider+模型 键的观测，以及给界面用的派生判断。 */
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

/** 错误正文里的时刻：`YYYY-MM-DD HH:mm:ss`，日期与时间之间允许空格或 `T`（WorkBuddy 官方客户端同口径）。 */
const RESET_TIMESTAMP = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/gu

/** 时刻后缀的显式时区：`UTC+8` / `UTC+08:00` / `GMT-5` / `(UTC+8)`。 */
const RESET_UTC_OFFSET = /^\s*\(?\s*(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\s*\)?/iu

/** 时刻后缀的 ISO 偏移：`+08:00` / `+0800`（部分上游用这种写法）。 */
const RESET_ISO_OFFSET = /^\s*\(?\s*([+-])(\d{2}):?(\d{2})\s*\)?/u

/** 恢复类关键词：正文里出现多个时刻时，用它挑出「恢复时刻」那一个。 */
const RESET_KEYWORD = /reset|resets|重置|恢复|刷新/iu

/**
 * 正文时刻省略时区时的默认解释：UTC+8（上海壁钟）。
 *
 * 这是 WorkBuddy 官方客户端自己的口径——它的解析正则把
 * ` UTC+8` / ` (UTC+8)` 当作**可选**后缀，并在缺失时直接
 * `Date.UTC(y, m-1, d, h-8, ...)`，即按 UTC+8 反解。本模块对齐这一口径；
 * 调用方仍可通过 options 覆盖。
 */
export const DEFAULT_BARE_WALL_CLOCK_OFFSET_MINUTES = 8 * 60

/**
 * 把一个「壁钟时刻 + 时区偏移」换算成毫秒 epoch，并做日历回滚与过去时刻校验。
 *
 * @param parts - 正文里读到的年月日时分秒与偏移分钟数（东八区为 +480）。
 * @param nowMs - 解析基准时刻（过去超过一天的场合直接拒绝）。
 * @returns 毫秒 epoch；字段非法或日期不存在时为 undefined。
 */
function resetEpochFromParts(
  parts: { year: number, month: number, day: number, hour: number, minute: number, second: number },
  offsetMinutes: number,
  nowMs: number,
): number | undefined {
  const { year, month, day, hour, minute, second } = parts
  if (month < 1 || month > 12 || day < 1 || day > 31
    || hour > 23 || minute > 59 || second > 59
    || Math.abs(offsetMinutes) > 14 * 60) return undefined
  const offsetMs = offsetMinutes * 60_000
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMs
  if (!Number.isFinite(utcMs)) return undefined
  // 日历回滚校验：2 月 30 日会被 Date.UTC 顺延成 3 月 2 日，那不是上游写的时刻。
  const check = new Date(utcMs + offsetMs)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
    return undefined
  }
  if (utcMs < nowMs - 86_400_000) return undefined
  return utcMs
}

/**
 * 解析一个正文时刻：后缀有显式时区就用它，没有就按 {@link DEFAULT_BARE_WALL_CLOCK_OFFSET_MINUTES}。
 *
 * @param text - 上游错误正文原文。
 * @param match - {@link RESET_TIMESTAMP} 命中项。
 * @param nowMs - 解析基准时刻。
 * @param bareOffsetMinutes - 正文省略时区时的解释偏移（默认 UTC+8）。
 * @returns 毫秒 epoch；字段非法/日期不存在/明显过去时为 undefined。
 */
function resetEpochFromMatch(
  text: string,
  match: RegExpExecArray,
  nowMs: number,
  bareOffsetMinutes: number,
): number | undefined {
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const matched = match[0] ?? ''
  const after = text.slice(match.index + matched.length)
  let offsetMinutes: number
  const utc = RESET_UTC_OFFSET.exec(after)
  if (utc !== null) {
    offsetMinutes = (utc[1] === '+' ? 1 : -1) * (Number(utc[2]) * 60 + Number(utc[3] ?? '0'))
  } else {
    const iso = RESET_ISO_OFFSET.exec(after)
    offsetMinutes = iso === null
      ? bareOffsetMinutes
      : (iso[1] === '+' ? 1 : -1) * (Number(iso[2]) * 60 + Number(iso[3]))
  }
  return resetEpochFromParts({
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
    hour: Number(hourText),
    minute: Number(minuteText),
    second: Number(secondText),
  }, offsetMinutes, nowMs)
}

/** 关键词出现的位置（正文里所有 reset/重置/恢复 的位置，供时刻消歧用）。 */
function keywordPositions(text: string): number[] {
  const positions: number[] = []
  const pattern = new RegExp(RESET_KEYWORD.source, 'giu')
  for (;;) {
    const match = pattern.exec(text)
    if (match === null) break
    positions.push(match.index)
  }
  return positions
}

/**
 * 时刻与最近关键词的距离（正文有多个时刻时用于消歧）。
 *
 * @param positions - {@link keywordPositions} 的结果。
 * @param index - 时刻起点。
 * @param length - 时刻长度。
 * @returns 距离；正文里没有关键词时为 undefined。
 */
function keywordDistance(positions: readonly number[], index: number, length: number): number | undefined {
  let best: number | undefined
  for (const position of positions) {
    const distance = position < index ? index - (position + 1) : Math.max(0, position - (index + length))
    if (best === undefined || distance < best) best = distance
  }
  return best
}

/**
 * 解析错误正文里明写的恢复时刻，统一成毫秒 epoch。
 *
 * 口径与 WorkBuddy 官方客户端一致（见模块头注释）：
 * - 在正文里搜 `YYYY-MM-DD[ T]HH:mm:ss`；
 * - 后缀 ` UTC+8` / ` (UTC+8)` / `UTC±N` / `±HH:MM` 有就用；
 * - **省略时区时按 UTC+8 解释**（官方客户端同口径，本插件这条路径只在
 *   429/soft_rate 上下文调用，正文里的时刻就是恢复时刻）；
 * - 正文出现多个时刻时，优先取 `reset/重置/恢复/刷新` 附近的那个；无法唯一
 *   确定就取最靠前的一个（与官方客户端「先命中先用」一致，不为多个候选编造）。
 *
 * 日期字段做日历回滚校验（`02-30` 之类不能悄悄变成 3 月 2 日），过去超过
 * 一天的时刻也不当恢复时刻。
 *
 * @param value - 上游错误正文原文。
 * @param nowMs - 解析基准时刻（用于拒绝明显过去的时刻）。
 * @param options - `bareWallClockOffsetMinutes`：正文时刻省略时区时的解释偏移，默认 480（UTC+8）。
 * @returns 毫秒 epoch；无法可靠解析时为 undefined。
 */
export function parseResetMessage(
  value: string | null | undefined,
  nowMs: number,
  options: { bareWallClockOffsetMinutes?: number } = {},
): number | undefined {
  if (value === null || value === undefined) return undefined
  const bareOffsetMinutes = options.bareWallClockOffsetMinutes ?? DEFAULT_BARE_WALL_CLOCK_OFFSET_MINUTES
  const candidates: { atMs: number, index: number, length: number }[] = []
  const pattern = new RegExp(RESET_TIMESTAMP.source, 'gu')
  for (;;) {
    const match = pattern.exec(value)
    if (match === null) break
    const atMs = resetEpochFromMatch(value, match, nowMs, bareOffsetMinutes)
    if (atMs !== undefined) candidates.push({ atMs, index: match.index, length: (match[0] ?? '').length })
  }
  const [first] = candidates
  if (first === undefined) return undefined
  if (candidates.length === 1) return first.atMs
  // 多个时刻：取离 reset/重置/恢复 最近的那个；都没有关键词就取最靠前的
  // （与 WorkBuddy 官方客户端「先命中先用」一致）。
  const positions = keywordPositions(value)
  let best = first
  let bestDistance = keywordDistance(positions, first.index, first.length)
  for (const candidate of candidates.slice(1)) {
    const distance = keywordDistance(positions, candidate.index, candidate.length)
    if (distance !== undefined && (bestDistance === undefined || distance < bestDistance)) {
      best = candidate
      bestDistance = distance
    }
  }
  return best.atMs
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
  /** 上游错误体原文：部分上游把恢复时刻写在文案里而不是响应头。 */
  body?: string
  nowMs?: number
}): RateLimitObservation | undefined {
  const nowMs = input.nowMs ?? Date.now()
  const isRate = input.kind === 'soft_rate' || RATE_LIMIT_STATUSES.has(input.status)
  if (!isRate) return undefined
  // soft_rate 之外的状态码不算限流（例如 500 也被某些上游说成「稍后重试」，
  // 但那是服务端故障，不是额度节奏）。
  if (input.kind !== 'soft_rate' && !RATE_LIMIT_STATUSES.has(input.status)) return undefined
  // 响应头优先（机器可读、无歧义）；没有才看错误正文里的时刻。
  const resetAtMs = parseResetHeader(input.headers?.get('retry-after'), nowMs)
    ?? parseResetHeader(input.headers?.get('x-ratelimit-reset'), nowMs)
    ?? parseResetMessage(input.body, nowMs)
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
 * 台账行键：provider + 模型。
 *
 * 模型缺省代表「上游没告诉我们哪个模型」的 provider 级观测（例如传输层只给了
 * 状态码）；有模型时按模型分行，因为 WorkBuddy 的限流就是按模型计的。
 *
 * @param provider - 变体 id。
 * @param model - 模型 id，未知时省略。
 * @returns Map 键。
 */
function ledgerKey(provider: string, model: string | undefined): string {
  return model === undefined || model === '' ? `${provider}\u0000` : `${provider}\u0000${model}`
}

/**
 * 内存台账：按 provider+模型 合并同一段限流期，并派生界面需要的视图。
 *
 * 合并规则：同一行（同一 provider 的同一模型）在「仍处于限流中」时再次撞到
 * 限流，视为同一次持续限流——保留最早的 `blockedAtMs`（用户想知道「等了
 * 多久」）、刷新 `lastSeenAtMs` 与 `hits`、用最新的 `resetAtMs` 覆盖（上游
 * 每次都会给更准的值）。一旦上一次已过期，就是新的一段限流，重新计时。
 *
 * **只观测、不拦截**：任何请求都不会因为台账里有活跃观测而被拒绝，是否放行
 * 完全由上游决定；一次成功请求只清掉它自己那一行的观测。
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
    const key = ledgerKey(observation.provider, observation.model)
    const previous = this.observations.get(key)
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
    this.observations.set(key, merged)
    return merged
  }

  /**
   * 清掉观测：一次成功请求只证明**它自己那个模型**的限流解除。
   *
   * 上游按模型限流时，B 模型成功不能拿来清 A 模型的观测（否则卡片会把还在
   * 限流的 A 误报成已恢复）。不传 `model` 时清该 provider 的全部观测——那是
   * 「整条通道都验证过」的口径，只给确实不分模型的场景用。
   *
   * @param provider - 变体 id。
   * @param model - 模型 id；省略表示清整个 provider。
   */
  clear(provider: string, model?: string): void {
    if (model !== undefined && model !== '') {
      this.observations.delete(ledgerKey(provider, model))
      // 同一次成功也说明渠道整体可用：把「模型未知」的 provider 级观测一并清掉。
      this.observations.delete(ledgerKey(provider, undefined))
      return
    }
    for (const key of [...this.observations.keys()]) {
      if (key.startsWith(`${provider}\u0000`)) this.observations.delete(key)
    }
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

  /** 该 provider 当前全部活跃观测（按最近被限时间倒序），卡片逐模型展示。 */
  activesFor(provider: string): readonly RateLimitObservation[] {
    return this.snapshot(provider).active
  }

  /** 最近一次活跃观测，没有则 undefined（pill 这类 provider 级表面用它代表当前状态）。 */
  activeFor(provider: string): RateLimitObservation | undefined {
    return this.snapshot(provider).active[0]
  }
}
