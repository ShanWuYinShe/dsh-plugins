/**
 * WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
 * token refresh, model catalog, and credit balance. The wire behavior is
 * ported from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
 * battle-tested against the real endpoint.
 *
 * @module dsh-any-connect/upstream
 */

import type { WorkBuddyCredential } from './auth.js'
import { appUserAgent, resolveAppVersion, type AppVersionInfo } from './app-version.js'
import type { ProbeAttempt } from './probe.js'
import { ZCodeClientSigner } from './zcode-signer.js'

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
export function modelWithCurrentPromotion(model: WorkBuddyUpstreamModel, now = Date.now()): WorkBuddyUpstreamModel {
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
    if (systemParts.length > 0 && typeof obj['system'] !== 'string') {
      obj['system'] = systemParts.join('\n\n')
      obj['messages'] = filteredMessages
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
    const headerTimer = new AbortController()
    const timer = setTimeout(
      () => headerTimer.abort(new Error(`no response headers within ${CHAT_HEADER_TIMEOUT_MS}ms`)),
      CHAT_HEADER_TIMEOUT_MS,
    )
    const international = regionOf(credential.domain) === 'global'
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        // 国际网关硬性要求首条 system 消息（缺失即 400/11128），国内线不加。
        body: international ? prepareInternationalChatBody(bodyJson) : bodyJson,
        // 调用方断开信号与头超时合并：任一触发都中止请求。
        signal: signal === undefined ? headerTimer.signal : AbortSignal.any([headerTimer.signal, signal]),
      })
    } catch (error: unknown) {
      // fetch 本身抛错（取消/传输错误/头超时）同样要拆掉定时器：超时回调对
      // 已 settled 的 controller 是无害 no-op，但定时器会继续挂住事件循环
      // 30s，连续失败的请求会积攒一堆待触发回调。
      clearTimeout(timer)
      // 客户端主动断开（pi-ai 取消生成）不是上游故障，按 client 分类回报；
      // shim 对这类结果不向已销毁的 socket 回写错误。
      if (signal?.aborted) {
        return { ok: false, status: 0, kind: 'client', message: 'client disconnected before upstream response' }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) {
      clearTimeout(timer) // 头已到：流式阶段不受头超时约束
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
      clearTimeout(timer)
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
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
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
  }
}

/** Options for ZCodeUpstreamClient. */
export interface ZCodeUpstreamClientOptions {
  signer?: ZCodeClientSigner
  models?: readonly WorkBuddyUpstreamModel[]
}

/**
 * ZCode upstream client: client request signing V4 handshake and per-request
 * signing for BigModel Coding Plan, streaming chat completions, model list,
 * and subscription quota.
 */
export class ZCodeUpstreamClient {
  private readonly signer: ZCodeClientSigner
  private readonly models: readonly WorkBuddyUpstreamModel[]

  constructor(options: ZCodeUpstreamClientOptions = {}) {
    this.signer = options.signer ?? new ZCodeClientSigner()
    this.models = options.models ?? []
  }

  /** POST the BigModel Anthropic messages endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    const headerTimer = new AbortController()
    const timer = setTimeout(
      () => headerTimer.abort(new Error(`no response headers within ${CHAT_HEADER_TIMEOUT_MS}ms`)),
      CHAT_HEADER_TIMEOUT_MS,
    )
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
        signal: signal === undefined ? headerTimer.signal : AbortSignal.any([headerTimer.signal, signal]),
      })
    } catch (error: unknown) {
      clearTimeout(timer)
      if (signal?.aborted) {
        return { ok: false, status: 0, kind: 'client', message: 'client disconnected before upstream response' }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) {
      clearTimeout(timer)
      return { ok: true, response }
    }
    let text: string
    try {
      text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    } catch {
      return { ok: false, status: response.status, kind: 'server', message: '(error body unavailable)' }
    } finally {
      clearTimeout(timer)
    }
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  async fetchModels(_credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    return this.models
  }

  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    try {
      const response = await fetch('https://bigmodel.cn/api/biz/subscription/list', {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
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
