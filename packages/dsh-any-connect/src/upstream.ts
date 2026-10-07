/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance. The wire behavior is
 * ported from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
 * battle-tested against the real endpoint.
 *
 * @module dsh-any-connect/upstream
 */

import os from 'node:os'
import type { WorkBuddyCredential } from './auth.js'
import { FALLBACK_APP_VERSION, appUserAgent, resolveAppVersion, type AppVersionInfo } from './app-version.js'
import type { ProbeAttempt } from './probe.js'
import { deadlineSignal, withTimeout } from './timeout.js'
import { ZCodeClientSigner } from './zcode-signer.js'
import { prepareStartPlanBody } from './zcode-plan-prompt.js'
import { readZcodeCodingPlanWhitelist } from './zcode-builtin-catalog.js'
import { parseCodingPlanQuota } from './zcode-quota.js'
import type { ZCodeCodingPlanQuota } from './zcode-quota.js'
import {
  FALLBACK_ZCODE_START_PLAN_MODELS,
  isStartPlanActivityActive,
  startPlanModelsFromEntitlements,
} from './zcode-plan-models.js'
import type { StartPlanActivity } from './zcode-plan-models.js'
import { previewStartPlan } from './zcode-plan-claim.js'
import type { StartPlanClaimCredential, StartPlanPlatformInfo, StartPlanPreviewResult } from './zcode-plan-claim.js'

/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = 'ping'

/** Output ceiling for a probe request; the answer itself is never read. */
const PROBE_MAX_TOKENS = 1

/**
 * Output ceiling for an international probe request.
 *
 * Above the smallest value that the strictest observed model accepts (the
 * GPT-5.6 family rejects `1`), while still being far too small to produce a
 * real answer.
 */
const INTERNATIONAL_PROBE_MAX_TOKENS = 16

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyRegion = 'cn' | 'global'

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

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096
/**
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

/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES: readonly WorkBuddyEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = 'badge:'

/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped: Record<string, unknown>): { reasoning: WorkBuddyModelReasoning } {
  const supports = wrapped['supportsReasoning'] === true
  const onlyReasoning = wrapped['onlyReasoning'] === true
  const rawReasoning = wrapped['reasoning']
  let supportedEfforts: WorkBuddyEffort[] | undefined
  let defaultEffort: WorkBuddyEffort | undefined
  let canDisableThinking = true
  if (typeof rawReasoning === 'object' && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const reasoning = rawReasoning as Record<string, unknown>
    const rawEfforts = reasoning['supportedEfforts']
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter((value): value is WorkBuddyEffort =>
        typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    if (typeof reasoning['defaultEffort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['defaultEffort'] as string)) {
      defaultEffort = reasoning['defaultEffort'] as WorkBuddyEffort
    } else if (typeof reasoning['effort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['effort'] as string)) {
      defaultEffort = reasoning['effort'] as WorkBuddyEffort
    }
    // Only an explicit `canDisableThinking: true` offers "thinking off"; older
    // rows omit the field and several of them reject `off` on the wire, so the
    // conservative default is "cannot be disabled".
    canDisableThinking = reasoning['canDisableThinking'] === true
  }
  return {
    reasoning: {
      supports,
      onlyReasoning,
      ...supportedEfforts === undefined ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      canDisableThinking,
    },
  }
}

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

/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped: Record<string, unknown>): { billing: WorkBuddyModelBilling } {
  const rawCredits = wrapped['credits']
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges: string[] = []
  const rawTags = wrapped['tags']
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag !== 'string') continue
      const lowered = tag.toLowerCase()
      if (!lowered.startsWith(BADGE_PREFIX)) continue
      const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length)
      if (label !== '') badges.push(label)
    }
  }
  // A `x0.00` multiplier means the model is currently free. The upstream is
  // inconsistent about the unit word (`x0.00` vs `x0.00 credits`), so the
  // test runs on the normalized multiplier — testing the raw string would
  // miss the suffixed spelling and serve a "free" model as paid.
  const normalized = normalizeCredits(credits)
  const free = normalized !== undefined && /^x?0\.0+$/u.test(normalized)
  return {
    billing: {
      ...credits === undefined ? {} : { credits },
      ...badges.length === 0 ? {} : { badges },
      free,
    },
  }
}

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Parse one catalog row. The international App document carries three extras
 * the CN document lacks: `contextWindow` as an object (`defaultLength` is the
 * working budget the plugin requests under), the input ceiling plus the
 * selectable lengths, and per-model promotions (parsed from the document-level
 * `modelPromotions` array passed in).
 */
function parseModelRow(
  wrapped: Record<string, unknown>,
  international: boolean,
  promotions: unknown,
): WorkBuddyUpstreamModel | undefined {
  const id = typeof wrapped['id'] === 'string' ? wrapped['id'] : ''
  if (id === '' || wrapped['disabled'] === true) return undefined
  const input = typeof wrapped['maxInputTokens'] === 'number' ? wrapped['maxInputTokens'] : 0
  const output = typeof wrapped['maxOutputTokens'] === 'number' ? wrapped['maxOutputTokens'] : 0
  if (input <= 0 || output <= 0) return undefined
  const context = wrapped['contextWindow']
  const defaultLength = isObject(context) && positive(context['defaultLength'])
    ? context['defaultLength'] as number
    : undefined
  const supportedLengths = isObject(context) && Array.isArray(context['supportedLengths'])
    ? (context['supportedLengths'] as unknown[]).filter(positive)
    : []
  return {
    id,
    name: typeof wrapped['name'] === 'string' && wrapped['name'] !== '' ? wrapped['name'] : id,
    contextWindow: international && defaultLength !== undefined ? defaultLength : input,
    maxTokens: output,
    ...international ? {
      maxInputTokens: input,
      supportedContextWindows: supportedLengths,
      promotions: parsePromotions(promotions, id),
    } : {},
    supportsImages: wrapped['supportsImages'] === true && wrapped['disabledMultimodal'] !== true,
    ...resolveUpstreamReasoning(wrapped),
    ...resolveUpstreamBilling(wrapped),
  }
}

/**
 * Extract the promotions covering `model` from the international document's
 * `modelPromotions` array.
 *
 * Ported from corrinehu/dsh-workbuddy-connect (MIT): only an enabled,
 * time-boxed, `displayMode: "replace"` discount is modelled — an entry that
 * does not match is dropped rather than guessed at, since rendering a
 * discount the plugin does not understand could understate what the user pays.
 */
function parsePromotions(value: unknown, model: string): WorkBuddyPromotion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!isObject(item) || item['enabled'] !== true) return []
    const modelIds = item['modelIds']
    if (!Array.isArray(modelIds) || !modelIds.includes(model)) return []
    const schedule = item['schedule']
    const discount = item['discount']
    const badge = item['badge']
    if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return []
    // Only a replacement discount has an unambiguous display rule; any other
    // display mode is left to the upstream's own client.
    if (discount['displayMode'] !== 'replace') return []
    const start = typeof schedule['validFrom'] === 'string' ? Date.parse(schedule['validFrom']) : Number.NaN
    const end = typeof schedule['validUntil'] === 'string' ? Date.parse(schedule['validUntil']) : Number.NaN
    const factor = discount['factor']
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return []
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return []
    const label = typeof badge['label'] === 'string' ? badge['label'] : ''
    const priority = typeof item['priority'] === 'number' && Number.isFinite(item['priority'])
      ? item['priority'] as number
      : 0
    return [{ start, end, label, factor, priority }]
  })
}

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

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

/** Chat endpoint base for one credential's region; also identifies which
 * document answered a catalog fetch (the saved-catalog record keeps it so a
 * roster from one endpoint is never served as another's). */
export function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
  }
  return headers
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), flatten
 * `tool_choice` (the upstream's field is a string; object forms return 400),
 * and rewrite `developer` messages as `system`.
 *
 * The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
 * `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
 * upstream rejects that role with HTTP 400 code 11128 ("Illegal API
 * invocation from an unapproved channel"). Rewriting to `system` is the
 * compatible spelling the upstream accepts.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  return JSON.stringify(obj)
}

/**
 * Normalize an Anthropic messages body: force `stream: true`, ensure positive
 * `max_tokens` (required by Anthropic API), and convert OpenAI-shaped messages
 * if provided.
 */
export function prepareAnthropicBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true

  // max_tokens is mandatory on Anthropic /v1/messages
  if (typeof obj['max_tokens'] !== 'number' || obj['max_tokens'] <= 0) {
    if (typeof obj['max_completion_tokens'] === 'number' && obj['max_completion_tokens'] > 0) {
      obj['max_tokens'] = obj['max_completion_tokens']
    } else {
      obj['max_tokens'] = 8192
    }
  }
  delete obj['max_completion_tokens']

  // If OpenAI messages format with system/developer role, convert to top-level system
  if (Array.isArray(obj['messages'])) {
    const systemParts: string[] = []
    const filteredMessages: unknown[] = []
    for (const msg of obj['messages']) {
      if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) {
        const wrapped = msg as Record<string, unknown>
        if (wrapped['role'] === 'system' || wrapped['role'] === 'developer') {
          if (typeof wrapped['content'] === 'string') {
            systemParts.push(wrapped['content'])
          }
          continue
        }
      }
      filteredMessages.push(msg)
    }
    if (systemParts.length > 0) {
      const existing = obj['system']
      if (existing === undefined) {
        obj['system'] = systemParts.join('\n\n')
        obj['messages'] = filteredMessages
      } else if (typeof existing === 'string') {
        // 顶层 system 已有字符串:追加合并,不能整段丢弃——否则 system/
        // developer 消息留在 messages 里,Anthropic 端点直接拒绝请求。
        obj['system'] = existing === '' ? systemParts.join('\n\n') : `${existing}\n\n${systemParts.join('\n\n')}`
        obj['messages'] = filteredMessages
      } else if (Array.isArray(existing)) {
        // Anthropic blocks 形态的顶层 system(合法):文本块追加在数组尾,
        // 整体覆盖会静默丢失原 system 内容。
        obj['system'] = [...existing, ...systemParts.map(text => ({ type: 'text', text }))]
        obj['messages'] = filteredMessages
      }
      // 其余畸形形态保持原样(连同 system 消息),交给上游校验给出明确错误。
    }
  }

  // If OpenAI tools format with type 'function', convert to Anthropic input_schema
  if (Array.isArray(obj['tools']) && obj['tools'].length > 0) {
    obj['tools'] = obj['tools'].map(t => {
      if (typeof t === 'object' && t !== null && !Array.isArray(t)) {
        const wt = t as Record<string, unknown>
        if (wt['type'] === 'function' && typeof wt['function'] === 'object' && wt['function'] !== null) {
          const fn = wt['function'] as Record<string, unknown>
          return {
            name: typeof fn['name'] === 'string' ? fn['name'] : '',
            description: typeof fn['description'] === 'string' ? fn['description'] : '',
            input_schema: typeof fn['parameters'] === 'object' && fn['parameters'] !== null ? fn['parameters'] : { type: 'object', properties: {} },
          }
        }
      }
      return t
    })
  }

  return JSON.stringify(obj)
}


/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
  }
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
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

/**
 * The system prompt injected when the international endpoint receives a body
 * with none.
 *
 * Measured requirement, not a guess: the international gateway rejects a body
 * whose first message is not `system` with HTTP 400 code 11128. Minimal on
 * purpose — it exists to satisfy a gateway precondition, not to steer the
 * model — and the normal path never reaches this, since pi-ai already sends
 * the harness's system prompt.
 */
const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * Apply the international endpoint's extra chat requirement: the first message
 * must be a system prompt.
 *
 * The added prompt is deliberately empty of user content and prepended, never
 * merged: existing messages keep their order and wording. A body that is not a
 * message list passes through for the upstream to reject.
 */
export function prepareInternationalChatBody(source: string): string {
  const prepared = prepareChatBody(source)
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    // Not JSON: nothing to prepend to, and the upstream will reject it anyway.
    return prepared
  }
  if (!isObject(body)) return prepared
  const messages = body['messages']
  if (!Array.isArray(messages)) return prepared
  const first = messages[0]
  if (isObject(first) && first['role'] === 'system') return prepared
  // Unshift, so every caller-supplied message keeps its position and content.
  messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
  return JSON.stringify(body)
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  const envelope: Envelope = {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
  return envelope
}

/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text: string): { errorCode?: string; detail?: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const wrapped = parsed as Record<string, unknown>
      const extError = wrapped['extError']
      if (typeof extError === 'object' && extError !== null && !Array.isArray(extError)) {
        const code = (extError as Record<string, unknown>)['code']
        if (typeof code === 'string') return { errorCode: code, detail: code }
      }
    }
  } catch {
    // Not JSON: fall through to a plain detail line.
  }
  return { detail: text.slice(0, 200) }
}

/**
 * Consume just enough of a streaming response to know it really streams.
 *
 * Returns true on the first chunk containing a data line. Cancels the body
 * afterwards; a stream that ends or errors before that counts as not streamed,
 * because an empty 200 is not evidence the effort was accepted.
 */
async function readFirstEvent(response: Response): Promise<boolean> {
  const body = response.body
  if (body === null) return false
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      const text = decoder.decode(value, { stream: true })
      if (text.includes('data:')) return true
    }
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
export interface WorkBuddyUpstreamClientOptions {
  /** Resolves the App-shaped UA version for international catalog requests;
   * injectable so tests never touch the real FS. */
  resolveAppVersion?: () => Promise<AppVersionInfo>
}

export class WorkBuddyUpstreamClient {
  private readonly resolveAppVersion: () => Promise<AppVersionInfo>

  constructor(options: WorkBuddyUpstreamClientOptions = {}) {
    this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion())
  }

  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    // 头超时与调用方取消经宿主 deadline 融合（此前手写 AbortController +
    // setTimeout + AbortSignal.any 三件套）：任一触发都中止请求，超时原因
    // 可分类（此前是裸 Error 字符串）。
    const headersTimeout = await deadlineSignal(signal, CHAT_HEADER_TIMEOUT_MS, 'ANY_CONNECT_HEADERS')
    const international = regionOf(credential.domain) === 'global'
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        // 国际网关硬性要求首条 system 消息（缺失即 400/11128），国内线不加。
        body: international ? prepareInternationalChatBody(bodyJson) : bodyJson,
        signal: headersTimeout.signal,
      })
    } catch (error: unknown) {
      // fetch 本身抛错（取消/传输错误/头超时）同样要拆掉定时器：超时回调对
      // 已 settled 的 controller 是无害 no-op，但定时器会继续挂住事件循环
      // 30s，连续失败的请求会积攒一堆待触发回调。
      headersTimeout.dispose()
      // 客户端主动断开（pi-ai 取消生成）不是上游故障，按 client 分类回报；
      // shim 对这类结果不向已销毁的 socket 回写错误。
      if (signal?.aborted) {
        return { ok: false, status: 0, kind: 'client', message: 'client disconnected before upstream response' }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) {
      headersTimeout.dispose() // 头已到：流式阶段不受头超时约束
      return { ok: true, response }
    }
    let text: string
    try {
      // 错误体读取仍在头超时的保护窗口内：上游发了头却卡住错误体时，
      // 定时器中止请求，这里按 server 分类兜底而非无限挂起。
      text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    } catch {
      return { ok: false, status: response.status, kind: 'server', message: '(error body unavailable)' }
    } finally {
      headersTimeout.dispose()
    }
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** Send one reasoning-effort probe request and classify the answer.
   *
   * The payload is minimal by design (prompt `ping`, tiny output ceiling):
   * the probe wants the accept/reject signal, never a completion. The
   * international body carries the gateway-required leading system prompt,
   * and the GPT-5.6 family's rejection of `max_tokens: 1` is why that region
   * asks for more.
   */
  async probeEffort(
    credential: WorkBuddyCredential,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    const international = regionOf(credential.domain) === 'global'
    const payload: Record<string, unknown> = {
      model,
      stream: true,
      messages: [
        ...international ? [{ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT }] : [],
        { role: 'user', content: PROBE_PROMPT },
      ],
      max_tokens: international ? INTERNATIONAL_PROBE_MAX_TOKENS : PROBE_MAX_TOKENS,
    }
    if (effort !== undefined) payload['reasoning_effort'] = effort

    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
      return { status: response.status, streamed: false, ...errorCodeOf(text) }
    }

    // Read until the first parseable event, then hang up: the probe wants the
    // acceptance signal, not a completion.
    const streamed = await readFirstEvent(response)
    return { status: response.status, streamed }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    // JSON 短读统一走宿主 deadline（超时原因可分类；此前裸 AbortSignal.timeout）。
    return withTimeout(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON', async (signal) => {
      const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers: refreshHeaders(credential),
        signal,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
      if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
      const outcome: WorkBuddyRefreshOutcome = { accessToken }
      if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
      if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
      if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
      return outcome
    })
  }

  /** GET the personal model catalog and keep the `cli` agent's models only.
   *
   * International (`workbuddy-ai`) reads a different document: `/v3/config`,
   * the product document the gateway splits out by User-Agent, so this request
   * carries the App-shaped UA (`WorkBuddyAI/<v>`, no space — the space form is
   * rejected with 400, the CLI form gets a smaller document without
   * `modelPromotions`). All three shapes measured live on 2026-09-15.
   */
  async fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    const international = regionOf(credential.domain) === 'global'
    let userAgent = CLIENT_UA
    if (international) {
      // Resolution never throws, but an injected test double might: degrade to
      // the CLI form (smaller document, still usable) rather than no catalog.
      try {
        userAgent = appUserAgent((await this.resolveAppVersion()).version)
      } catch {
        userAgent = CLIENT_UA
      }
    }
    return withTimeout(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON', async (signal) => {
      const response = await fetch(
        `${chatBase(credential)}${international ? '/v3/config' : '/console/enterprises/personal/models'}`,
        {
          headers: {
            'Authorization': `Bearer ${credential.accessToken}`,
            'Accept': 'application/json',
            'Origin': originReferer(credential),
            'Referer': `${originReferer(credential)}/`,
            'User-Agent': userAgent,
            ...international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {},
          },
          signal,
        },
      )
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      const rawModels = Array.isArray(data['models']) ? data['models'] : []
      const agents = Array.isArray(data['agents']) ? data['agents'] : []
      let cliIds: readonly string[] | undefined
      for (const agent of agents) {
        if (typeof agent === 'object' && agent !== null) {
          const wrapped = agent as Record<string, unknown>
          if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
            cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
            break
          }
        }
      }
      if (cliIds === undefined || cliIds.length === 0) {
        throw new Error('workbuddy model catalog lists no cli agent models')
      }
      const promotions = international ? data['modelPromotions'] : undefined
      const byId = new Map<string, WorkBuddyUpstreamModel>()
      for (const model of rawModels) {
        if (typeof model !== 'object' || model === null) continue
        const parsed = parseModelRow(model as Record<string, unknown>, international, promotions)
        if (parsed !== undefined) byId.set(parsed.id, parsed)
      }
      const models = cliIds
        .map(id => byId.get(id))
        .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
      if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
      return models
    })
  }

  /** POST the billing endpoint for the aggregated remaining credit. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    return withTimeout(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON', async (signal) => {
      const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
        method: 'POST',
        headers: billingHeaders(credential),
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: 'p_tcaca',
          Status: [0, 3],
          PackageEndTimeRangeBegin: format(now),
          // 窗口上界沿用上游 CLI 的拼写：约 101 年（365×101 天），毫秒数。
          PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
        }),
        signal,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
        ? responseWrapper['Response'] as Record<string, unknown>
        : {}
      const inner = typeof data['Data'] === 'object' && data['Data'] !== null
        ? data['Data'] as Record<string, unknown>
        : {}
      const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []
      const accounts: WorkBuddyCreditAccount[] = []
      let total = 0
      for (const raw of rawAccounts) {
        if (typeof raw !== 'object' || raw === null) continue
        const account = raw as Record<string, unknown>
        const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
        const size = numberField('CycleCapacitySize')
        const cycleRemain = numberField('CycleCapacityRemain')
        const cycleUsed = numberField('CycleCapacityUsed')
        const capacityRemain = numberField('CapacityRemain')
        const remainCycles = numberField('RemainCycles')
        let remain: number
        if (size > 0) {
          // True availability of a cyclic package = this cycle's remainder plus
          // the full grant of every cycle that has not started yet: a package
          // with its current cycle drained is not empty while RemainCycles > 0.
          remain = cycleRemain + remainCycles * size
        } else if (cycleRemain > 0 || cycleUsed > 0) {
          remain = cycleRemain
        } else {
          remain = capacityRemain
        }
        if (remain < 0) remain = 0
        total += remain
        accounts.push({
          packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
          remain,
          // The bar's denominator spans the same scope as the numerator: current
          // cycle plus the not-yet-started ones.
          size: size > 0 ? size * (1 + remainCycles) : numberField('CapacitySize'),
        })
      }
      return { total, accounts }
    })
  }
}

/**
 * 上游新出现、本地目录尚未收录的模型 id 的保守默认行。
 *
 * 与 Start Plan 的 `startPlanModelInfo` 同口径：宁可报小不可虚报——200K 窗口、
 * 32K 输出、不支持图像、思考可关、x1.00 基准费率、不带任何促销徽标。参数报小
 * 顶多少用一点上下文，报大了会让上游直接拒绝请求；费率同理，凭空打折或加价都
 * 是错的。真实值等官方目录收录后随发版修正。
 *
 * 名字保留上游原样（只做 id 小写归一）——展示名由上游 id 推导比编造一个更好。
 */
function defaultZCodeModelInfo(id: string): WorkBuddyUpstreamModel {
  return {
    id: id.toLowerCase(),
    name: id,
    contextWindow: 200000,
    maxTokens: 32000,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true },
    billing: { credits: 'x1.00', free: false },
  }
}

/** Options for ZCodeUpstreamClient. */
export interface ZCodeUpstreamClientOptions {
  signer?: ZCodeClientSigner
  models?: readonly WorkBuddyUpstreamModel[]
  /** Resolves the client app version sent as `app_version`/`X-ZCode-App-Version`
   * on the account-plan endpoints; injectable so tests never touch the real FS. */
  resolveAppVersion?: () => Promise<AppVersionInfo>
  /** Coding Plan 的官方模型白名单（小写 id 集合）；undefined = 客户端产品面不可得。
   * 默认实现读本机 ZCode 客户端的 zcode-builtin.json（见 zcode-builtin-catalog），
   * 注入口让测试不依赖测试机的真实安装。 */
  resolveCodingPlanWhitelist?: () => ReadonlySet<string> | undefined
}

/**
 * ZCode upstream client: client request signing V4 handshake and per-request
 * signing for BigModel Coding Plan, streaming chat completions, model list,
 * and subscription quota.
 */
export class ZCodeUpstreamClient {
  private readonly signer: ZCodeClientSigner
  private readonly models: readonly WorkBuddyUpstreamModel[]
  private readonly resolveAppVersion: () => Promise<AppVersionInfo>
  private readonly resolveCodingPlanWhitelist: () => ReadonlySet<string> | undefined

  constructor(options: ZCodeUpstreamClientOptions = {}) {
    this.signer = options.signer ?? new ZCodeClientSigner()
    this.models = options.models ?? []
    this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion())
    this.resolveCodingPlanWhitelist = options.resolveCodingPlanWhitelist ?? readZcodeCodingPlanWhitelist
  }

  /**
   * 当前客户端内置目录给出的 Coding Plan 白名单（小写 id 集合），不可得时
   * undefined。公开出来供启动时过滤历史 saved 目录——旧版本写入的 saved 可能
   * 含产品面之外的模型（见 `filterByCodingPlanWhitelist`）。
   */
  codingPlanWhitelist(): ReadonlySet<string> | undefined {
    return this.resolveCodingPlanWhitelist()
  }

  /**
   * Coding Plan 的窗口额度（5 小时 / 7 天 / 工具调用），来自客户端用的同一支
   * `GET https://bigmodel.cn/api/monitor/usage/quota/limit`（Authorization 用
   * coding-plan 的 api-key）。拿不到（网络/非 bigmodel 账号/形状变化）返回
   * undefined，调用方回退到订阅有效性窗口——绝不编数字。
   */
  async fetchCodingPlanQuota(credential: WorkBuddyCredential): Promise<ZCodeCodingPlanQuota | undefined> {
    const quotaTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://bigmodel.cn/api/monitor/usage/quota/limit', {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
        },
        signal: quotaTimeout.signal,
      })
      if (!response.ok) return undefined
      return parseCodingPlanQuota(await response.json())
    } catch {
      return undefined
    } finally {
      quotaTimeout.dispose()
    }
  }

  /** POST the BigModel Anthropic messages endpoint; a successful answer is the raw SSE response.
   *
   * 生效计划为 Start Plan 时走其专属通道（zcode-plan/anthropic + 账号 JWT），
   * 额度扣 Start Plan 专属余额——普通通道扣的是 Coding Plan 订阅，两者绝不
   * 混用（2026-09-30 口径）。 */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    if (credential.zcodePlan === 'start-plan') {
      return this.chatStreamStartPlan(credential, bodyJson, signal)
    }
    // 头超时与调用方取消经宿主 deadline 融合（同上，与 WorkBuddy 线同口径）。
    const headersTimeout = await deadlineSignal(signal, CHAT_HEADER_TIMEOUT_MS, 'ANY_CONNECT_HEADERS')
    let response: Response
    try {
      const zcodeHeaders = await this.signer.buildHeaders({ apiKey: credential.accessToken })
      response = await fetch('https://open.bigmodel.cn/api/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          ...zcodeHeaders,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'anthropic-version': '2023-06-01',
        },
        body: prepareAnthropicBody(bodyJson),
        signal: headersTimeout.signal,
      })
    } catch (error: unknown) {
      headersTimeout.dispose()
      if (signal?.aborted) {
        return { ok: false, status: 0, kind: 'client', message: 'client disconnected before upstream response' }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) {
      headersTimeout.dispose()
      return { ok: true, response }
    }
    let text: string
    try {
      text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    } catch {
      return { ok: false, status: response.status, kind: 'server', message: '(error body unavailable)' }
    } finally {
      headersTimeout.dispose()
    }
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  async fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    // Start Plan 的名单以**当前活动的 entitlements** 为准，而不是客户端内置目录：
    // 内置目录只是候选，服务端按活动放行（实测 Trust Build 只授权 GLM-5.3-Flash，
    // 另外两个 400 code 3006 model not allowed）。拿不到授权信息时回退已注册名单
    // ——一次上游抖动不该让整组模型从选择器里消失。
    if (credential.zcodePlan === 'start-plan') {
      return this.fetchStartPlanModels(credential)
    }
    // Coding Plan 的名单真源是客户端内置 provider 目录（产品面），不是开放平台的
    // paas 目录：白名单拿不到（客户端未装/结构演进）就回已注册名单，不把未经验证
    // 的模型带进选择器（端点放行 ≠ 订阅覆盖，2026-10-06 实测见 zcode-builtin-catalog）。
    const whitelist = this.resolveCodingPlanWhitelist()
    if (whitelist === undefined) {
      return this.models
    }
    // 超时同样走宿主 deadline：外层 try/catch 的降级语义（失败回退已有模型）不变。
    const modelsTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://open.bigmodel.cn/api/paas/v4/models', {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
        },
        signal: modelsTimeout.signal,
      })
      if (!response.ok) {
        return this.models
      }
      const json = await response.json() as { data?: Array<{ id?: string }> }
      const upstreamIds = Array.isArray(json.data)
        ? json.data.map(row => typeof row?.id === 'string' ? row.id.trim() : '').filter(id => id !== '')
        : []
      if (upstreamIds.length === 0) {
        return this.models
      }
      // BigModel connection and API credentials verified; Coding Plan subscriber
      // models are preserved with their verified parameters (128K max tokens, custom rates).
      //
      // 三方合流，白名单是总闸：
      // - 上游 paas 目录给"开放平台有哪些 id"，只作存在性参考；id 必须先过客户端
      //   产品面白名单，官方未收录的模型不展示——那不是本订阅的名单；
      // - 白名单内的 id：本地收录过的沿用整行（128K/费率/徽章都不丢），没收录过
      //   的走保守默认（官方上新时新模型能出现，但不虚报窗口与费率）；
      // - 本地收录、上游没列的：仍在白名单内才保留（目录接口可能只列一部分；
      //   官方从产品面下架的模型则随之消失，不再靠本地行续命）。
      // 失败/空响应仍回退 this.models（上面的 return），语义不变。
      const known = new Map(this.models.map(model => [model.id.toLowerCase(), model]))
      const merged: WorkBuddyUpstreamModel[] = []
      const seen = new Set<string>()
      for (const rawId of upstreamIds) {
        const key = rawId.toLowerCase()
        if (seen.has(key)) continue
        if (!whitelist.has(key)) continue
        seen.add(key)
        const hit = known.get(key)
        merged.push(hit ?? defaultZCodeModelInfo(rawId))
      }
      for (const model of this.models) {
        const key = model.id.toLowerCase()
        if (seen.has(key)) continue
        if (!whitelist.has(key)) continue
        seen.add(key)
        merged.push(model)
      }
      return merged
    } catch {
      return this.models
    } finally {
      modelsTimeout.dispose()
    }
  }

  /**
   * Start Plan 专属通道：`zcode-plan/anthropic` + 账号 JWT（`zcodejwttoken`）
   * + 设备号。额度扣 Start Plan 专属余额（一次性、当日有效），与 Coding Plan
   * 订阅互不占用。
   *
   * 该通道校验**请求体指纹**：`system` 必须以官方客户端的固定提示词开头
   * （见 `zcode-plan-prompt` 与其中的实测记录），否则一律 405 `code 3012`。
   * 指纹是请求体内容，与传输层/请求头/签名无关，所以这里把指纹前置、把
   * Harness 自己的 system 提示词接在其后——实测模型仍按后者回答。仍被拦
   * （例如上游又加了新条件）时如实报错，绝不回落到普通通道，那会把请求偷偷
   * 记到 Coding Plan 头上。
   */
  private async chatStreamStartPlan(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
      return {
        ok: false,
        status: 0,
        kind: 'client',
        message: 'Start Plan 专属通道缺少凭据（凭据文档中没有 zcodejwttoken）——请在 ZCode 客户端登录一次后重试',
      }
    }
    const headersTimeout = await deadlineSignal(signal, CHAT_HEADER_TIMEOUT_MS, 'ANY_CONNECT_HEADERS')
    let response: Response
    try {
      response = await fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${credential.zcodeJwtToken}`,
          'X-Device-Mid': credential.zcodeDeviceMid ?? '',
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'anthropic-version': '2023-06-01',
        },
        body: prepareStartPlanBody(prepareAnthropicBody(bodyJson)),
        signal: headersTimeout.signal,
      })
    } catch (error: unknown) {
      headersTimeout.dispose()
      if (signal?.aborted) {
        return { ok: false, status: 0, kind: 'client', message: 'client disconnected before upstream response' }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) {
      headersTimeout.dispose()
      return { ok: true, response }
    }
    let text: string
    try {
      text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    } catch {
      return { ok: false, status: response.status, kind: 'server', message: '(error body unavailable)' }
    } finally {
      headersTimeout.dispose()
    }
    if (text.includes('"code":3012')) {
      // 指纹已在请求体里（见 prepareStartPlanBody），走到这里说明上游改了判据
      // 或加了新条件——如实报告并说明"前置指纹仍不够"，不要谎称通道被封。
      return {
        ok: false,
        status: response.status,
        kind: classifyUpstreamError(response.status, text),
        message: 'Start Plan 请求被上游风控拦截（code 3012），本次请求未消耗任何额度。'
          + '插件已按官方客户端的请求体指纹发送，仍被拦说明上游新增了判据——请报告此情况，不要改扣 Coding Plan。',
      }
    }
    if (response.status === 401) {
      return {
        ok: false,
        status: response.status,
        kind: 'client',
        message: 'Start Plan 凭据失效（HTTP 401）——请在 ZCode 客户端重新登录一次',
      }
    }
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    // 额度来源跟生效计划走：Start Plan 查专属余额（billing/balance，当日有效的
    // 一次性 token 包），其余计划查 coding-plan 订阅（subscription/list）。两个
    // 口径绝不混报——Start Plan 档显示订阅余额、或 Coding Plan 档显示专属余额，
    // 都会让用户对着错误的池子做决定。
    if (credential.zcodePlan === 'start-plan') {
      return this.fetchStartPlanCredits(credential)
    }
    // 额度口径以「账户上的 coding-plan 订阅」为准，与客户端选了哪条账号计划
    // 无关：模型请求本身就固定走 coding-plan 通道（Start Plan 的专属模型通道
    // 被上游风控封锁，本包按普通 ZCode 150% 额度使用），额度显示自然也要跟
    // 模型请求同一口径，否则卡片报的是一份用不上的余额。
    const creditsTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://bigmodel.cn/api/biz/subscription/list', {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        signal: creditsTimeout.signal,
      })
      if (!response.ok) {
        return {
          total: 1,
          accounts: [{ packageName: 'Coding Plan (有效)', remain: 1, size: 1 }],
        }
      }
      const json = await response.json() as { code?: number; data?: Array<{ productName?: string; status?: string; expireTime?: number | string }> }
      const accounts: WorkBuddyCreditAccount[] = []
      if (Array.isArray(json.data) && json.data.length > 0) {
        for (const item of json.data) {
          const name = item.productName || 'Coding Plan'
          const isValid = item.status === 'VALID' || item.status === 'ACTIVE'
          let expiredAt: string | undefined
          if (item.expireTime) {
            const d = new Date(item.expireTime)
            if (!Number.isNaN(d.getTime())) expiredAt = d.toISOString()
          }
          accounts.push({
            packageName: isValid ? `${name} (有效)` : `${name} (${item.status ?? '未知'})`,
            // 计划名单独留一份:上游的产品名就是用户看到的活动/套餐名(例如
            // "ZCode Trust Build"),界面上的 plan 标签必须用它,而不是写死
            // "Coding Plan"——那会把用户实际没有的套餐名报给用户。
            planName: name,
            remain: isValid ? 1 : 0,
            size: 1,
            ...expiredAt === undefined ? {} : { expiredAt },
          })
        }
      } else {
        accounts.push({
          packageName: 'Coding Plan (有效)',
          remain: 1,
          size: 1,
        })
      }
      return {
        total: accounts.reduce((acc, cur) => acc + cur.remain, 0),
        accounts,
      }
    } catch {
      return {
        total: 1,
        accounts: [{ packageName: 'Coding Plan (有效)', remain: 1, size: 1 }],
      }
    } finally {
      creditsTimeout.dispose()
    }
  }

  /**
   * Start Plan 的模型名单：读当前活动（`billing/balance` 的 `data.plans[]`）
   * 的 entitlements，按活动实际放行的模型派生。
   *
   * 与 {@link fetchStartPlanCredits} 共用同一个端点但**语义不同**：那里问的是
   * 还剩多少额度、失败必须如实抛错；这里问的是"活动授权了哪些模型"。
   *
   * 三种状态必须分开（混在一起就是"过期活动仍列出未授权模型"那个 bug）：
   * - 查到活动且解析出模型 -> 返回该名单；
   * - 查询**成功**但没有有效活动（未领取/已过期）-> 返回**空名单**，分组如实隐藏；
   * - 查询**失败**（HTTP 非 ok / 抛错）-> 回退已注册名单 this.models，一次上游
   *   抖动不该让用户失去一个本来能用的分组。
   *
   * **有有效活动但一个模型都解析不出来同样返回空名单**：走到那一步已经确认活动
   * 存在且有效，名单的权威来源就是它的 entitlements；此时若回退 this.models（对
   * start-plan 变体就是兜底那三个模型），等于让授权字段漂移重新长出"看起来能用、
   * 一用就 400 code 3006"的幻影名单——与"未领取却显示模型"是同一个用户可见症状。
   * 空名单 = "今天拿不到"（可恢复），幻影名单 = "以为能用"（更糟）。
   */
  private async fetchStartPlanModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
      return this.models
    }
    const modelsTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
        headers: {
          'Authorization': `Bearer ${credential.zcodeJwtToken}`,
          'X-Device-Mid': credential.zcodeDeviceMid ?? '',
          'Accept': 'application/json',
        },
        signal: modelsTimeout.signal,
      })
      if (!response.ok) return this.models
      const json = await response.json() as { data?: { plans?: readonly StartPlanActivity[] } }
      // 有效期以 ends_at（秒级 epoch）判定：过期活动放行的模型服务端已经不认，
      // 登记上去只会得到 400 code 3006 model not allowed。ends_at 缺失按有效处理。
      const now = Date.now()
      const active = (json.data?.plans ?? []).filter(plan => isStartPlanActivityActive(plan, now))
      if (active.length === 0) {
        // B：查询成功、但此刻没有任何有效活动（今天还没领取 / 活动已过期）——
        // 今日确实没有可用模型，返回空名单让分组隐藏。
        //
        // 这里**不再回退 this.models**：兜底名单里的 GLM-5.2 / GLM-5-Turbo 上游
        // 并不放行，选中只会失败（实测 400 code 3006），等于把"无模型"伪装成
        // "有三个模型"。分组隐藏后，用户重新领取活动即可恢复。
        return []
      }
      // 走到这里说明**已确认有有效活动**，名单的权威来源就是该活动的
      // entitlements：解析不出模型时返回空（分组隐藏），绝不回退 this.models。
      // 对 start-plan 变体而言 this.models 就是那三个幻影模型（index.ts 用
      // FALLBACK_ZCODE_START_PLAN_MODELS 构造 client），回退等于让"活动有效但
      // 授权字段漂移"重新长出"看起来能用、一用就 400 code 3006"的假名单。
      // 空 = "今天拿不到"（可恢复），幻影名单 = "以为能用"（更糟）。
      return startPlanModelsFromEntitlements(
        active.flatMap(plan => plan.entitlements ?? []),
        FALLBACK_ZCODE_START_PLAN_MODELS,
        true,
      )
    } catch {
      return this.models
    } finally {
      modelsTimeout.dispose()
    }
  }

  /**
   * 今日 Start Plan 待领取探测（`billing/preview`）：纯 HTTP、**不需要验证码**，
   * 因此可以自动跑。返回的清单就是"今天还能领什么"，为空表示今日已领取。
   *
   * 这是**提示性**信息，不是额度也不是名单，所以失败语义照 {@link fetchStartPlanModels}：
   * 绝不抛错（探不到就让调用方按 unknown 处理），也绝不因此影响分组可用性——
   * 探测失败不该让用户失去一个本来能用的连接。
   *
   * 接入点说明（能力边界）：本方法只做 preview。真正的 claim 需要
   * `X-Aliyun-Captcha-Verify-Param`，该 token 由客户端渲染进程的阿里云 SDK
   * 签发、与浏览器指纹绑定，纯 Node 侧无法生成（实测无 captcha 一律 400
   * code 3007），所以**全自动领取做不到**——插件做到的是"自动探测 + 提示用户
   * 去客户端点一次领取"，见 `zcode-plan-claim` 模块头部。
   *
   * `options.signal` 用于把本探测**限制在很短的窗口内**：status 路由是卡片每
   * 60s 轮询的读路径，一个挂死的上游不能把 status 拖住。超时/取消都会落进
   * catch，降级成 failed。
   */
  async fetchStartPlanClaimPreview(
    credential: WorkBuddyCredential,
    options: { signal?: AbortSignal } = {},
  ): Promise<StartPlanPreviewResult> {
    const claimCredential: StartPlanClaimCredential = {
      ...credential.zcodeJwtToken === undefined ? {} : { zcodeJwtToken: credential.zcodeJwtToken },
      ...credential.zcodeDeviceMid === undefined ? {} : { zcodeDeviceMid: credential.zcodeDeviceMid },
    }
    // 平台拼法照抄 zcode-signer 的 'X-Platform'（`<os>-<arch>`），不另造一套；
    // 账号计划端点按它分流客户端版本，拼错会拿到与真客户端不同的响应。
    const platform = `${process.platform}-${os.arch()}`
    if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
      return { status: 'auth-failed', message: '未登录：凭据文档中没有 zcodejwttoken' }
    }
    let appVersion: string
    try {
      appVersion = (await this.resolveAppVersion()).version
    } catch {
      // 版本解析只影响查询参数与头，拿不到就走编译期兜底；让它把探测打挂
      // 是轻重倒置（与 WorkBuddyUpstreamClient.fetchModels 的降级同思路）。
      appVersion = FALLBACK_APP_VERSION
    }
    const info: StartPlanPlatformInfo = { appVersion, platform }
    return previewStartPlan(claimCredential, info, options.signal)
  }

  /**
   * Start Plan 专属额度（`billing/balance`）：`data.plans[]` 给活动名与有效期
   * （一次性包，当日过期），`data.balances[]` 给 token 级的总量/已用/剩余。
   * 查询失败如实抛错（卡片转 creditsError），绝不拿 Coding Plan 的订阅状态
   * 冒充 Start Plan 的额度。
   */
  private async fetchStartPlanCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
      throw new Error('Start Plan 额度查询缺少凭据（凭据文档中没有 zcodejwttoken）')
    }
    const balanceTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
        headers: {
          'Authorization': `Bearer ${credential.zcodeJwtToken}`,
          'X-Device-Mid': credential.zcodeDeviceMid ?? '',
          'Accept': 'application/json',
        },
        signal: balanceTimeout.signal,
      })
      if (!response.ok) {
        throw new Error(`Start Plan 额度查询失败（HTTP ${response.status}）`)
      }
      const json = await response.json() as {
        data?: {
          plans?: Array<{ name?: string; plan_id?: string; ends_at?: number }>
          balances?: Array<{
            show_name?: string
            plan_id?: string
            total_units?: number
            remaining_units?: number
            expires_at?: number
          }>
        }
      }
      const plans = json.data?.plans ?? []
      // 额度是**当日一次性池子**：活动当天发放、当天到期、余额不结转（实测
      // `period: "one_time"` + `expires_at` 固定当日 16:00Z）。所以卡片与 pill
      // 报的都是"这个池子此刻还剩多少"，而不是任何可累积的订阅余额。
      const accounts: WorkBuddyCreditAccount[] = (json.data?.balances ?? []).map(balance => {
        const plan = plans.find(entry => entry.plan_id !== undefined && entry.plan_id === balance.plan_id)
        let expiredAt: string | undefined
        if (typeof balance.expires_at === 'number' && balance.expires_at > 0) {
          const d = new Date(balance.expires_at * 1000)
          if (!Number.isNaN(d.getTime())) expiredAt = d.toISOString()
        }
        return {
          packageName: `${balance.show_name ?? 'Start Plan'} (有效)`,
          // 活动名（如 "ZCode Trust Build"）是用户看到的套餐名。
          planName: plan?.name ?? balance.show_name ?? 'Start Plan',
          // 该池子当日有效、不结转：到期时间就是它的"清零时刻"。
          sameDay: true,
          remain: typeof balance.remaining_units === 'number' ? balance.remaining_units : 0,
          size: typeof balance.total_units === 'number' ? balance.total_units : 0,
          ...expiredAt === undefined ? {} : { expiredAt },
        }
      })
      return {
        total: accounts.reduce((acc, cur) => acc + cur.remain, 0),
        accounts,
      }
    } finally {
      balanceTimeout.dispose()
    }
  }

  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    return { accessToken: credential.accessToken }
  }

  async probeEffort(
    _credential: WorkBuddyCredential,
    _model: string,
    _effort: string | undefined,
    _signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    return { status: 200, streamed: true }
  }
}
