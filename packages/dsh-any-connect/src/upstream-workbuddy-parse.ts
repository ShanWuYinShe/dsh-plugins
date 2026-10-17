/**
 * upstream-workbuddy-parse.ts — WorkBuddy 上游响应的纯解析（模型行/促销/计费/推理）。
 *
 * 2026-10-08 从 711 行的 upstream-workbuddy.ts 拆出：无 I/O，可单独喂样本测试。
 *
 * @module dsh-any-connect/upstream-workbuddy-parse
 */

import {
  normalizeCredits,
  type WorkBuddyUpstreamModel,
  type WorkBuddyModelReasoning,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyPromotion,
} from './upstream-shared.js'

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

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Parse one catalog row. The international App document carries three extras
 * the CN document lacks: `contextWindow` as an object (the plugin works under
 * the largest declared selectable length — users asked for maximum context —
 * clamped to the input ceiling), the input ceiling plus the selectable
 * lengths, and per-model promotions (parsed from the document-level
 * `modelPromotions` array passed in).
 */
export function parseModelRow(
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
  // Working budget: prefer the largest selectable window (some models expose
  // several), falling back to `defaultLength`, then the input ceiling — the
  // budget never exceeds what the upstream actually accepts. The wire request
  // carries no length parameter, so this only sets how much the plugin packs.
  const preferred = Math.max(...supportedLengths, defaultLength ?? 0)
  return {
    id,
    name: typeof wrapped['name'] === 'string' && wrapped['name'] !== '' ? wrapped['name'] : id,
    contextWindow: international ? Math.min(preferred, input) || input : input,
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

/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
