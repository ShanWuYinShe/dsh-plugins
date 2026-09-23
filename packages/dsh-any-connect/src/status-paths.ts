/** Node-free constants and types shared by the Host and browser halves. */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDY_STATUS_PATH = '/plugins/dsh-any-connect/status'

/**
 * The international (WorkBuddy AI) variant's own status route.
 *
 * A separate constant rather than a computed suffix so both halves reference
 * literal strings: the browser bundle and the host bundle are built
 * independently, and a shared expression is one build-config drift away from
 * the card asking a route the host never mounted.
 */
export const WORKBUDDY_AI_STATUS_PATH = '/plugins/dsh-any-connect/ai/status'

export const WORKBUDDY_PROBE_PATH = '/plugins/dsh-any-connect/probe'

/** Plugin-owned probe control endpoint (international variant). */
export const WORKBUDDY_AI_PROBE_PATH = '/plugins/dsh-any-connect/ai/probe'

/** ZCode variant status route. */
export const ZCODE_STATUS_PATH = '/plugins/dsh-any-connect/zcode/status'

/** ZCode variant probe route. */
export const ZCODE_PROBE_PATH = '/plugins/dsh-any-connect/zcode/probe'

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyWebProbeSection {
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Recorded observations. */
  results: readonly WorkBuddyWebProbeModel[]
}

/** Action requested from the probe control route. */
export interface WorkBuddyProbeAction {
  /**
   * `refresh` re-reads the credential and re-fetches the model catalog.
   * Detection itself is automatic (every catalog refresh sweeps the missing
   * candidates), so this is the route's only action — still a write that
   * spends a request against the upstream, which is why it keeps this route's
   * in-process key and loopback guards rather than the read-only status GET.
   */
  action: 'refresh'
}

/**
 * One served model, as the card's unified model list renders it: one row
 * carrying every per-model fact the card shows — display name, working
 * context window, billing convenience facts, declared effort levels, and the
 * larger selectable windows. (Detection results stay in the probe section:
 * they carry their own validation/probed-at metadata.)
 */
export interface WorkBuddyWebModelRow {
  id: string
  name: string
  /**
   * Working budget in tokens: the window the plugin actually requests under
   * (the international document's `contextWindow.defaultLength` where
   * declared, else the row's input ceiling).
   */
  contextWindow: number
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /**
   * Credits multiplier in display form, e.g. `x0.79`. Unlike the model
   * picker's copy, the card renders through the browser locale, so this value
   * may be interpolated into a localized sentence rather than shown bare.
   */
  credits?: string
  /**
   * The rate cannot be stated right now, and the card must say so.
   *
   * Set for a row whose price came from a promotion that has since ended: the
   * upstream bakes the discounted value into the cached row, and the original
   * price is not recoverable from it, so neither the old figure nor `free` may
   * be repeated. The card renders "refresh to see the price" instead.
   */
  rateUnknown?: true
  /**
   * Upstream-declared effort levels, exactly as the catalog row declares them.
   * Absent means the row declares no explicit set — the probe section's
   * detection results (if any) then say what the upstream actually accepts.
   */
  efforts?: readonly string[]
  /**
   * Selectable larger windows the upstream declares, excluding the working
   * budget itself. Reported, never chosen: offering the ceiling as though it
   * were the working window would overstate the budget (the desktop app's
   * window picker is client-side policy that appears nowhere in the catalog).
   */
  largerWindows: readonly number[]
}

/** One billing package and its remaining credit. */
export interface WorkBuddyWebCreditAccount {
  packageName: string
  remain: number
  size: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyWebCredits {
  total: number
  accounts: readonly WorkBuddyWebCreditAccount[]
}

/**
 * Where the models a card is currently showing came from.
 *
 * The card must distinguish a live catalog from the built-in fallback, and
 * say when the last attempt failed — otherwise a stale list is
 * indistinguishable from an offline one, and a user cannot tell whether the
 * models they see still match the upstream.
 */
export interface WorkBuddyWebCatalog {
  /**
   * Where the models on screen came from, in degradation order:
   * `live` (fetched now) → `saved` (this account's last successful fetch,
   * restored after a restart or a failed fetch) → `fallback` (the roster
   * compiled into the plugin). The card distinguishes them because "stale"
   * and "offline with a saved list" are different situations for the user.
   */
  source: 'live' | 'saved' | 'fallback'
  /** When the live catalog last succeeded, epoch milliseconds. */
  fetchedAt?: number
  /** Why the most recent fetch failed, when it did, redacted for display. */
  error?: string
}

/** The JSON document the plugin card renders. */
export type WorkBuddyWebStatus =
  | {
    status: 'signed-out'
    /**
     * Why no credential is usable, when that is diagnosable rather than simply
     * "nobody signed in" — today a credential belonging to the other product.
     * The card renders it in place of the generic sign-in hint.
     */
    reason?: string
  }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyWebCredits
    creditsError?: string
    /** Every served model, one row each — the card's unified model list. */
    models?: readonly WorkBuddyWebModelRow[]
    /** Where those models came from, and whether the last fetch failed. */
    catalog?: WorkBuddyWebCatalog
    /** Reasoning-effort probe state and recorded observations. */
    probe?: WorkBuddyWebProbeSection
    /**
     * In-process key authorizing probe control writes. Handed to the card with
     * the status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    probeKey?: string
  }
  | { status: 'error'; message: string }
