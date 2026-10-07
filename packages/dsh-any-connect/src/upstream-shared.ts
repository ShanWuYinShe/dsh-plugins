/**
 * upstream-shared.ts — 上游协议共享层：类型、常量与跨客户端助手。
 *
 * 2026-10-08 从 upstream.ts（1765 行）拆出：原文件同时装着两个产品的 wire 实现
 * 与共享协议层。现在按「共享协议层 / WorkBuddy / ZCode」三分，upstream.ts 退化为
 * re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/upstream-shared
 */

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
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

export const JSON_TIMEOUT_MS = 30_000

export const ERROR_BODY_LIMIT = 4096

export /**
 * chat 请求「响应头到达前」的超时：只覆盖上游接受连接却不返回响应头的
 * 挂死窗口。fetch 一返回（头已到）定时器即撤销——SSE 流式阶段的长寿命
 * 不受它约束（流由调用方断开信号与 pi-ai 侧的 idle 超时兜底）；错误体
 * 的读取也在这枚定时器的保护窗口内完成。与各 JSON 端点的超时同值。
 */
const CHAT_HEADER_TIMEOUT_MS = 30_000

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some catalog
 * rows report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 * Dropping a trailing `credits` (case-insensitive, singular or plural) yields
 * the one spelling that reads identically in every language.
 *
 * @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
 * @returns the bare multiplier, or undefined when nothing displayable remains.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  // A string that is only the unit word (`credits`) carries no multiplier.
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/**
 * Whether the current time falls into the Beijing (UTC+8) off-peak night-free window (23:00 - 09:00).
 */
export function isZCodeOffpeak(date: Date = new Date()): boolean {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: 'numeric',
      hour12: false,
    })
    const hour = parseInt(formatter.format(date), 10)
    return hour >= 23 || hour < 9
  } catch {
    const utc = date.getTime() + date.getTimezoneOffset() * 60000
    const beijingHour = new Date(utc + 3600000 * 8).getHours()
    return beijingHour >= 23 || beijingHour < 9
  }
}

/**
 * Layer the currently-effective promotion onto a copy of one model row.
 *
 * Ported from corrinehu/dsh-workbuddy-connect (MIT). Non-destructive: the
 * model's own `credits` and `badges` are the base, and the promotion is
 * layered onto a copy. A model with no live promotion is returned as-is, so
 * the common case allocates nothing.
 *
 * The expired case is the load-bearing one: the upstream bakes the discounted
 * value into `credits` itself (free rows ship `credits: "x0.00"`), so keeping
 * that value after the window would advertise an ended discount — `free: true`
 * being the worst case. The original price is not recoverable from the row,
 * so the honest answer is to stop asserting one (`rateUnknown`).
 */
export function modelWithCurrentPromotion(
  model: WorkBuddyUpstreamModel,
  now = Date.now(),
  variantKind?: 'workbuddy' | 'zcode',
  nightFreeEligible = true,
): WorkBuddyUpstreamModel {
  // Determine if this model belongs to ZCode (either explicitly marked or by ZCode-specific privilege badges)
  const isZCode = variantKind === 'zcode'
    || (variantKind === undefined && (model.billing?.badges?.some(b => b.includes('150% 额度')) ?? false))

  if (isZCode) {
    // 夜间免费是 Coding Plan 的权益：Start Plan 走普通通道、只有 150% 额度，
    // 不享受 23:00–09:00 免费窗。此时既不能标「夜间免费」，也不能把费率改写成
    // x0.00——那会给用户一个它拿不到的折扣。行里自带的夜免徽标一并摘掉，
    // 其余徽标（如 150% 额度）保留。
    if (!nightFreeEligible) {
      return {
        ...model,
        billing: {
          ...model.billing,
          free: false,
          badges: (model.billing?.badges ?? []).filter(b => !b.includes('夜间免费')),
        },
      }
    }
    const hasNightFreeBadge = model.billing?.badges?.some(b => b.includes('夜间免费'))
    if (hasNightFreeBadge) {
      const offpeak = isZCodeOffpeak(new Date(now))
      if (offpeak) {
        return {
          ...model,
          billing: {
            ...model.billing,
            credits: 'x0.00',
            free: true,
            badges: (model.billing?.badges ?? []).map(b => b === '夜间免费' ? '夜间免费 (生效中)' : b),
          },
        }
      } else {
        // Daytime: keep the row's own baseline when it carries one. When it
        // doesn't (missing, or `x0.00` baked in by the night window), the
        // real daytime price is not recoverable — assert `rateUnknown`
        // instead of inventing a hardcoded rate the upstream may have
        // changed (same posture as expired promotions below).
        const daytimeCredits = model.billing?.credits !== undefined && model.billing.credits !== 'x0.00'
          ? model.billing.credits
          : undefined
        return {
          ...model,
          billing: {
            ...model.billing,
            // credits: undefined 显式抹掉行里被夜间窗口烙上的 x0.00——
            // spread 不能覆盖它,留着就会继续向用户展示已失效的免费价。
            ...daytimeCredits === undefined ? { rateUnknown: true as const, credits: undefined } : { credits: daytimeCredits },
            free: false,
            badges: (model.billing?.badges ?? []).map(b => b === '夜间免费 (生效中)' ? '夜间免费' : b),
          },
        }
      }
    }
    // Other ZCode models (e.g. GLM-5.3 x1.00) remain untouched with their own parameters and billing
    return model
  }

  // WorkBuddy variant (CN and Global): never apply ZCode's 23:00~09:00 off-peak rule
  if (model.promotions === undefined || model.promotions.length === 0) return model
  const promotion = [...model.promotions]
    .sort((a, b) => b.priority - a.priority)
    .find(candidate => now >= candidate.start && now < candidate.end)
  if (promotion === undefined) {
    const derivedFromPromotion = model.billing?.free === true
      || (model.billing?.badges?.length ?? 0) > 0
      || model.promotions.some(candidate => candidate.factor !== 1)
    if (!derivedFromPromotion) return model
    return {
      ...model,
      billing: {
        free: false,
        rateUnknown: true,
      },
    }
  }
  const rate = normalizeCredits(model.billing?.credits)
  const original = rate !== undefined && rate.startsWith('x') ? Number(rate.slice(1)) : Number.NaN
  // A replacement to zero is meaningful even when the base rate is unknown (the
  // App document's Auto row carries an empty rate string); any other multiplier
  // needs a number to scale, so it is skipped rather than invented.
  if (promotion.factor !== 0 && !Number.isFinite(original)) return model
  const value = promotion.factor === 0 ? 0 : original * promotion.factor
  return {
    ...model,
    billing: {
      ...model.billing,
      credits: `x${value.toFixed(2)}`,
      free: value === 0,
      badges: [
        ...(model.billing?.badges ?? []),
        ...promotion.label === '' ? [] : [promotion.label],
      ],
    },
  }
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

export /** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
  }
}

export /** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}
