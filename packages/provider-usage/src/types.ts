/** Node-free vocabulary shared by the host and browser halves of provider-usage. */

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
   * Provider-supplied label. Providers name their packages, so this is free
   * text and the surface renders it verbatim rather than translating it.
   */
  label: string
  /** Remaining amount, when the provider reports one. */
  remain?: number
  /** Denomination of `remain`/`limit`, e.g. `credits`, `usd`, `requests`. */
  unit: string
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

/** Route the browser half reads; the host half registers exactly this path. */
export const PROVIDER_USAGE_PATH = '/plugins/provider-usage/usage'
