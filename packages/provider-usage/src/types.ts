/** Node-free vocabulary shared by the host and browser halves of provider-usage. */

/**
 * A provider-supplied window label that a surface may localize.
 *
 * 字符串按原文渲染（provider 的套餐/余额名是专有名词，翻译反而失真）；
 * 需要本地化的 provider 给 `{ en, [locale] }` 结构：`en` 是必备的英语回退基线，
 * 其余键是 DSH locale id（如 `zh`、`ja`）。client 按 DSH 当前语言解析，
 * `/usage` 命令与任何 host 侧文本取 `en`。
 */
export interface LocalizedUsageLabel {
  /** English baseline；也是当前语言无对应条目时的回退。 */
  en: string
  /** 其他语言，键为 DSH locale id（如 `zh`）；值必须是字符串。 */
  readonly [locale: string]: string | undefined
}

/** A window label: plain provider text, or a localizable structure. */
export type UsageLabel = string | LocalizedUsageLabel

/**
 * Resolve one window label for a locale.
 *
 * 回退链：精确 locale → 主语言子标签（`zh-CN` → `zh`）→ `en` → 第一个非空值。
 * host 侧传 `'en'`（命令行文本只有一种语言）；client 传注入面拿到的当前语言。
 *
 * @param label - provider 给的 label。
 * @param localeId - DSH locale id；缺席时用 `en`。
 * @returns 永远返回字符串（结构异常时返回空串，不把 undefined 交给渲染层）。
 */
export function resolveUsageLabel(label: UsageLabel, localeId?: string): string {
  if (typeof label === 'string') return label
  if (localeId !== undefined && localeId !== '') {
    const exact = label[localeId]
    if (typeof exact === 'string' && exact !== '') return exact
    const language = localeId.split('-', 1)[0]
    if (language !== undefined && language !== localeId) {
      const primary = label[language]
      if (typeof primary === 'string' && primary !== '') return primary
    }
  }
  if (typeof label.en === 'string' && label.en !== '') return label.en
  for (const value of Object.values(label)) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/**
 * One quota or balance window a provider reports.
 *
 * Providers disclose wildly different things — a prepaid credit balance, a
 * monthly cycle with a reset date, a rolling rate limit — so a window is the
 * common shape rather than a fixed field set. A window with a `resetsAt` is a
 * limit that refills; one without is a balance that only runs down.
 */
export interface UsageWindow {
  /**
   * Stable identity within one snapshot, unique per window. Callers key React
   * lists by it and use it to keep a window's rendered value stable across
   * refetches.
   */
  id: string
  /**
   * Provider-supplied label — a package/balance name rendered verbatim, or a
   * localizable `{ en, [locale] }` structure (see {@link UsageLabel}).
   */
  label: UsageLabel
  /** Remaining amount, when the provider reports one. */
  remain?: number
  /**
   * Denomination of `remain`/`limit`, e.g. `credits`, `usd`, `requests`.
   *
   * 与 {@link UsageWindow.label} 同一套本地化契约：`'credits'` 这类计量单位通常
   * 是纯字符串，但任何面向用户的单位文本（`'有效'`、`'今日待领取'`、`'次'`）
   * 都可以给 `{ en, [locale] }`，由 surface 按 DSH 当前语言解析。
   * 空串仍是「无单位」的既有语义。
   */
  unit: UsageLabel
  /**
   * Window ceiling, when the provider reports one. Absent means "remaining is
   * the whole fact" (a balance), not "limit is zero".
   */
  limit?: number
  /** ISO-8601 instant this window refills, when the provider reports one. */
  resetsAt?: string
  /**
   * The window is exhausted right now: the provider refused the last request
   * for this window and nothing is left in it until `resetsAt`.
   *
   * Distinct from `remain: 0` on purpose. A drained balance ("no money left")
   * and a rate-limit block ("wait N seconds") both read as zero to a progress
   * bar, but they need different words: one is over until the user tops up, the
   * other clears itself. Only a querier that actually observed a refusal may
   * set this — inferring it from `remain: 0` would claim knowledge of the
   * upstream's admission decision that a balance reading does not carry.
   */
  blocked?: boolean
}

/** One provider's usage answer, as cached and as sent to the browser. */
export interface UsageSnapshot {
  /** Provider route key the answer belongs to. */
  provider: string
  /** Human-readable provider name, from the harness directory when known. */
  displayName?: string
  /** Provider-reported plan or tier name, when disclosed. */
  plan?: string
  /** Reported windows, in the provider's own order. Never undefined; possibly empty. */
  windows: readonly UsageWindow[]
  /** Epoch milliseconds this answer was produced. */
  fetchedAt: number
  /**
   * Redacted reason the query failed. Windows may still be present when a
   * later failure kept the last good answer; an empty window list plus an
   * error means nothing usable was ever returned.
   */
  error?: string
  /**
   * True when `windows` were carried over from the previous successful
   * answer because the latest query failed (`error` is set). The surface
   * dims the readout instead of presenting stale numbers as fresh.
   */
  degraded?: boolean
  /**
   * The provider is refusing requests right now for rate reasons, and when it
   * expects to accept them again.
   *
   * Separate from `windows` because the two answer different questions: a
   * window says how much is left, this says whether the channel admits a
   * request at all. A provider can be rate limited with plenty of quota left
   * (concurrency/window caps) — that is the common case for subscription
   * coding plans. A querier sets it only from an observation it actually made
   * (a 429/refusal with the upstream's headers), never by guessing a window.
   */
  rateLimit?: UsageRateLimit
}

/**
 * An observed rate-limit block.
 *
 * `resetAt` is present only when the upstream said so (`Retry-After` /
 * `X-RateLimit-Reset`). Providers that rate-limit by plan concurrency and
 * adjust it dynamically publish no window at all, so the absence of `resetAt`
 * is a fact to display, not a gap to fill with a computed guess.
 */
export interface UsageRateLimit {
  /** Epoch milliseconds the block was first observed. */
  blockedAt: number
  /** Epoch milliseconds it was most recently observed still blocking. */
  lastSeenAt: number
  /** Upstream-declared instant the channel reopens; absent when unstated. */
  resetAt?: number
  /** Upstream HTTP status that carried the refusal (429, or 403 for free tiers). */
  status: number
  /** Model the refusal was attributed to, when known. */
  model?: string
  /** Refusals observed within this continuous block. */
  hits: number
}

/** One OAuth/account wallet bucket, amounts already parsed to numbers. */
export interface AccountWalletBalance {
  /** Currency code as reported (e.g. 'CNY'). */
  currency: string
  /** Recharge-wallet remainder. */
  recharge: number
  /** Bonus-wallet remainder. */
  bonus: number
}

/** Everything a querier needs to ask one provider for its usage. */
export interface ProviderUsageContext {
  /** Provider route key being queried. */
  provider: string
  /** Endpoint the provider's models are served from, when configured. */
  baseURL?: string
  /** Resolved credential value, when the provider has one configured. */
  apiKey?: string
  /**
   * OAuth/account wallets, when the provider has no API key but the harness
   * holds a signed-in account for it (today: DeepSeek only). A querier prefers
   * `apiKey` and uses these only as the keyless fallback, so the two sources
   * never double-count.
   */
  accountWallets?: AccountWalletBalance[]
  /** Account-source failure text; set only when the keyless fallback itself failed. */
  accountError?: string
  /** Operator cancellation; a query must settle promptly after it aborts. */
  signal?: AbortSignal
}

/**
 * One provider's usage query.
 *
 * Registering a querier is how a provider gains a usage display: the harness
 * itself has no notion of provider quotas, so every provider's answer comes
 * from a querier someone contributed — this package's built-ins, or a plugin
 * that owns the provider and knows its billing endpoint.
 *
 * A querier that finds nothing to report returns an empty `windows` list
 * rather than throwing; that renders as "this provider reports no usage",
 * which is a different statement from a failed query.
 */
export type ProviderUsageQuerier = (context: ProviderUsageContext) => Promise<UsageSnapshot>

/**
 * 路由返回的一行答案：查询到的快照，或「该 provider 未注册查询器」标记。
 *
 * host 侧用它组装 GET 响应，browser 侧用同一类型解析响应——同一份线协议只
 * 在这一处定义，避免两侧各写一遍字面量后漂移。
 */
export type ProviderUsageAnswer = UsageSnapshot | { provider: string; queried: false }

/** Route the browser half reads; the host half registers exactly this path. */
export const PROVIDER_USAGE_PATH = '/plugins/provider-usage/usage'

/**
 * `GET PROVIDER_USAGE_PATH` 的响应体。
 *
 * `cacheTtlMs` 是宿主 registry 的**成功缓存时长**（部署配置项）：浏览器侧据此
 * 把下一次轮询排在缓存过期之后，而不是用自己硬编码的节拍去猜。旧宿主没有该
 * 字段时 client 回退到默认节拍（见 client/resource-provider.ts）。
 */
export interface ProviderUsageResponse {
  /** 与请求 providers 顺序一致的逐行答案。 */
  snapshots: ProviderUsageAnswer[]
  /** 宿主成功缓存时长（毫秒）。 */
  cacheTtlMs: number
}
