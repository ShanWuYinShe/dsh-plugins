/**
 * WorkBuddy model catalog: a static fallback list captured from the live
 * endpoint, replaced by the upstream's dynamic answer once it loads.
 *
 * @module dsh-any-connect/catalog
 */

import type { WorkBuddyUpstreamModel } from './upstream.js'
import { modelWithCurrentPromotion } from './upstream.js'

/** One model entry the adapter exposes. */
export type WorkBuddyModelInfo = WorkBuddyUpstreamModel

/**
 * Static CLI models observed on the CN endpoint (re-verified against the live
 * catalog 2026-09-15 against WorkBuddy desktop 5.5.6 / bundled CLI 2.137.1,
 * including thinking-effort and billing metadata). The upstream refresh
 * replaces this list at startup; it exists so the provider registers with a
 * usable catalog even while the first fetch is in flight or offline.
 *
 * The list tracks the `cli` agent's model roster exactly: the 16 models the
 * desktop CLI offers. Reasoning metadata is taken verbatim from the live
 * endpoint — each model's supported effort set and whether thinking can be
 * disabled — and the `free` flag follows the upstream `x0.00` credits marker.
 *
 * Two rows changed in this re-verification: `deepseek-v4-flash` is gone
 * (superseded by `deepseek-v4.1-flash`, x0.17 → x0.03) and
 * `kimi-k2.8-preview` is new. Refresh with
 * `node --experimental-strip-types <script>` against a signed-in desktop app
 * rather than editing by hand; the roster moves faster than this comment.
 */
export const FALLBACK_WORKBUDDY_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'auto', name: 'Auto', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { free: false } },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1000000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.29', badges: ['夜间免费'], free: false } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.00', badges: ['限时免费'], free: true } },
  { id: 'hy3-x', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.05', free: false } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.03', badges: ['独家优惠'], free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1000000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.06', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79', badges: ['夜间折扣'], free: false } },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200000, maxTokens: 48000, supportsImages: false, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', contextWindow: 200000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.71', free: false } },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1000000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1000000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.77', free: false } },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7-Code', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.57', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.52', free: false } },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.25', free: false } },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.51', free: false } },
]

/**
 * Static CLI models observed on the international (`workbuddy-ai`) endpoint
 * (captured 2026-09-15 from the App-shaped `/v3/config` document against a
 * signed-in desktop app: `WorkBuddyAI/<v>` UA, no space — the space form is
 * rejected, the CLI form returns a smaller document without `modelPromotions`).
 *
 * The list tracks the `cli` agent's model roster exactly: the 20 models the
 * desktop App offers, including the virtual Auto/Fast/Balanced/Primary/Deep
 * aliases and the GPT/Gemini rows the CN endpoint does not serve. Working
 * windows follow the document's `contextWindow.defaultLength` where declared
 * (the budget the plugin requests under), matching the live parser.
 *
 * The two rows whose price depends on an expiring promotion (`hy3`,
 * `deepseek-v4.1-flash`) carry `rateUnknown` instead of the baked-in `x0.00`:
 * once the trial window passes, repeating that figure would advertise an
 * ended discount. Do not hand-edit prices here; re-capture from the live
 * document.
 */
export const FALLBACK_WORKBUDDY_AI_MODELS: readonly WorkBuddyModelInfo[] = [
  { id: 'default-model', name: 'Auto', contextWindow: 176000, maxTokens: 24000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: false }, billing: { free: false } },
  { id: 'fast-model', name: 'Fast', contextWindow: 200000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.34', free: false } },
  { id: 'balanced-model', name: 'Balanced', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.59', free: false } },
  { id: 'primary-model', name: 'Primary', contextWindow: 272000, maxTokens: 72000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.31', free: false } },
  { id: 'deep-model', name: 'Deep', contextWindow: 176000, maxTokens: 24000, supportsImages: true, reasoning: { supports: false, onlyReasoning: false, canDisableThinking: false }, billing: { credits: 'x3.33', free: false } },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 200000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['high'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x0.29', free: false } },
  { id: 'hy3', name: 'Hy3', contextWindow: 192000, maxTokens: 64000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 300000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false }, billing: { free: false, rateUnknown: true } },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', contextWindow: 400000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x6.67', free: false } },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x3.47', free: false } },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x1.39', free: false } },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.14', free: false } },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 1000000, maxTokens: 128000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x3.31', free: false } },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272000, maxTokens: 72000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: false }, billing: { credits: 'x1.65', free: false } },
  { id: 'gemini-3.5-flash', name: 'Gemini-3.5-Flash', contextWindow: 1000000, maxTokens: 65536, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.99', free: false } },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 48000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 48000, supportsImages: true, reasoning: { supports: true, onlyReasoning: false, supportedEfforts: ['high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.79', free: false } },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 1000000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x1.62', free: false } },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false }, billing: { credits: 'x0.52', free: false } },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 300000, maxTokens: 32000, supportsImages: true, reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true }, billing: { credits: 'x0.77', free: false } },
]


/** Mutable catalog shared by the shim's `/v1/models` and the adapter.
 *
 * Visibility gates the whole roster: a signed-out variant is *empty* rather
 * than showing the fallback list — an empty catalog is how DSH hides a model
 * group (the host filters out groups with no models), which keeps a sign-in
 * that happens after startup working without re-registering the provider.
 * Models the user picked while visible stay registered-but-invisible; the
 * rows are kept so flipping back needs no re-fetch.
 */
export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[]
  private visible = true

  constructor(initial: readonly WorkBuddyModelInfo[] = FALLBACK_WORKBUDDY_MODELS) {
    this.models = initial
  }

  /**
   * Current entries; empty while the variant has no usable credential.
   * Promotion-bearing rows resolve to their currently-effective billing here,
   * so every consumer (adapter, shim, card) agrees on one price without each
   * reimplementing expiry.
   */
  current(): readonly WorkBuddyModelInfo[] {
    if (!this.visible) return []
    return this.models.map(model => modelWithCurrentPromotion(model))
  }

  /** Replace the list; the adapter's `getModels` reads the live catalog, so
   * the new entries are visible to the next snapshot without further wiring. */
  set(models: readonly WorkBuddyModelInfo[]): void {
    this.models = [...models]
  }

  /** Whether this variant's models are exposed at all. */
  isVisible(): boolean {
    return this.visible
  }

  /**
   * Show or hide the whole catalog. Returns whether the value changed, so the
   * caller can skip work that would re-render an identical list.
   */
  setVisible(visible: boolean): boolean {
    if (this.visible === visible) return false
    this.visible = visible
    return true
  }
}
