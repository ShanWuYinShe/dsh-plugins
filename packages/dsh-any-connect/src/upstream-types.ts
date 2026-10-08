/**
 * upstream-types.ts — 上游协议类型（纯声明，零运行时）。
 *
 * 2026-10-08 从 411 行的 upstream-shared.ts 拆出：类型与常量/助手分家，改类型不必翻逻辑；
 * 类型导入在编译后完全擦除，不引入任何运行时依赖。
 *
 * @module dsh-any-connect/upstream-types
 */

export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'auth_forbidden'
  | 'not_found'
  | 'server'
  | 'client'

/** One CLI-usable model as the upstream catalog describes it. */
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /**
   * The international document's larger selectable window, when it declares
   * one, and the model's maximum input ceiling.
   *
   * Kept apart from {@link WorkBuddyUpstreamModel.contextWindow} because they
   * answer different questions: `contextWindow` is the budget the plugin
   * actually requests under, while these are facts about what the upstream
   * will accept.
   */
  maxInputTokens?: number
  supportedContextWindows?: readonly number[]
  /** Verified promotions covering this model (international document only). */
  promotions?: readonly WorkBuddyPromotion[]
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire
   * effort values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto
   * pi-ai's thinking levels, and the supported set decides which levels the
   * DSH model selector offers.
   */
  reasoning?: WorkBuddyModelReasoning
  /**
   * Billing convenience metadata: the credits multiplier string the upstream
   * reports (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000` or `badge:夜间折扣:#1E90FF`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a
   * language-neutral display form (`x0.79`) that reads the same in every UI
   * language. The raw upstream string (which may spell `x0.79 credits`) stays
   * on {@link WorkBuddyModelBilling.credits} for diagnostics.
   */
  billing?: WorkBuddyModelBilling
}

/** Reasoning metadata the upstream catalog declares for one model. */
export interface WorkBuddyModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyEffort[]
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyEffort
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean
}

/** The concrete effort spellings WorkBuddy exposes on the wire. */
export type WorkBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Billing convenience metadata reported for one model. */
export interface WorkBuddyModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[]
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean
  /**
   * The rate cannot be stated right now, and the card must say so.
   *
   * Set for a row whose price came from a promotion that has since ended: the
   * upstream bakes the discounted value into the cached row, and the original
   * price is not recoverable from it, so neither the old figure nor `free` may
   * be repeated. The card renders "refresh to see the price" instead.
   */
  rateUnknown?: true
}

/** One verified promotion entry, from the international App document's
 * `modelPromotions` array. Only the shape actually observed is modelled. */
export interface WorkBuddyPromotion {
  /** Window start, epoch ms, parsed from the document's offset timestamp. */
  start: number
  /** Window end, epoch ms. */
  end: number
  /** Badge text as the upstream wrote it, e.g. `Free now`. */
  label: string
  /** Multiplier applied to the model's rate; `0` replaces it outright. */
  factor: number
  /** Higher wins when several promotions cover one model. */
  priority: number
}

/** One billing package and its remaining credit. */
export interface WorkBuddyCreditAccount {
  packageName: string
  remain: number
  size: number
  expiredAt?: string
  /**
   * The upstream plan this package belongs to, when it names one.
   *
   * ZCode's account plans are packages, not credits: the plan's own name is the
   * meaningful label ("ZCode Trust Build"), and a display that hardcodes
   * "Coding Plan" would report a plan the account does not have.
   */
  planName?: string
  /**
   * This pool is granted for one day and expires the same day — an unconsumed
   * remainder is not carried over.
   *
   * Set for ZCode Start Plan quota (measured 2026-09-30: `period: "one_time"`,
   * `expires_at` pinned to the day's end). The card must say so: a balance that
   * silently resets reads as "use it or lose it", and a user who thinks it
   * accumulates would budget against credit that does not exist.
   */
  sameDay?: true
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyCredits {
  total: number
  accounts: readonly WorkBuddyCreditAccount[]
}

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }
