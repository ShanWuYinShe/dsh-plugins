/**
 * The providers this one plugin serves: the two WorkBuddy desktop apps (CN +
 * international) and the GLM Coding Plan (`zcode`).
 *
 * WorkBuddy halves ported from corrinehu/dsh-workbuddy-connect
 * `src/variants.ts` (MIT), adapted to this package's naming (`anyconnect`
 * settings namespaces, `/plugins/dsh-any-connect` routes). Both products are
 * the same client framework in different regions, and both write their
 * sign-in into the *same* shared `CodeBuddyExtension` auth directory — they
 * differ by file basename, base URL, catalog endpoint, and display identity.
 *
 * The zcode provider is *not* a WorkBuddy region flip: its credential is a
 * static API key and its wire is the Anthropic Messages protocol. The
 * descriptor carries a `kind` discriminator so the host assembly can pick
 * the credential store, shim routes, and catalog lifecycle per provider
 * while registration itself stays one data-driven loop.
 *
 * @module dsh-any-connect/variants
 */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH, ZCODE_PROBE_PATH, ZCODE_STATUS_PATH } from './status-paths.js'
import type { WorkBuddyRegion } from './upstream.js'

/** Which upstream family a variant talks to; selects the per-kind wiring. */
export type VariantKind = 'workbuddy' | 'zcode'

/** One provider variant. */
export interface WorkBuddyVariant {
  /** Provider id registered with DSH, e.g. `workbuddy-ai`. */
  id: string
  /** Which upstream family this variant talks to. */
  kind: VariantKind
  /** Model-group heading and card title stem, e.g. `WorkBuddy AI`. */
  displayName: string
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string
  /** Which upstream region this variant's credentials must belong to. WorkBuddy only. */
  region?: WorkBuddyRegion
  /** Env var overriding the desktop auth-file location. WorkBuddy only. */
  env?: string
  /** Basename of the desktop app's own auth file in the shared auth directory. WorkBuddy only. */
  desktopFilename?: string
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string
  /**
   * Basename of the plugin-owned saved-catalog file under `$DSH_HOME`.
   *
   * One per variant: the two WorkBuddy endpoints disagree about rates,
   * windows, and even which models exist for a shared id, so a catalog saved
   * from one must never be served as the other's. (zcode never writes one —
   * its roster is static — but keeps the field so per-variant paths stay
   * disjoint.)
   */
  catalogFilename: string
  /** Settings namespace owning this variant's configuration card. */
  settingsNs: SettingsNamespace
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string
}

/** CN WorkBuddy first: the existing provider keeps its id, paths, and copy. */
export const WORKBUDDY_VARIANTS: readonly WorkBuddyVariant[] = [
  {
    id: 'workbuddy',
    kind: 'workbuddy',
    displayName: 'WorkBuddy',
    appName: 'WorkBuddy',
    region: 'cn',
    env: 'WORKBUDDY_AUTH_FILE',
    desktopFilename: 'workbuddy-desktop.info',
    ownFilename: '.workbuddy-auth.json',
    probeFilename: '.workbuddy-probe.json',
    catalogFilename: '.workbuddy-catalog.json',
    settingsNs: 'anyconnect' as SettingsNamespace,
    statusPath: WORKBUDDY_STATUS_PATH,
    probePath: WORKBUDDY_PROBE_PATH,
  },
  {
    id: 'workbuddy-ai',
    kind: 'workbuddy',
    displayName: 'WorkBuddy AI',
    appName: 'WorkBuddy AI',
    region: 'global',
    env: 'WORKBUDDY_AI_AUTH_FILE',
    desktopFilename: 'workbuddy-desktop-ai.info',
    ownFilename: '.workbuddy-ai-auth.json',
    probeFilename: '.workbuddy-ai-probe.json',
    catalogFilename: '.workbuddy-ai-catalog.json',
    settingsNs: 'anyconnect-ai' as SettingsNamespace,
    statusPath: WORKBUDDY_AI_STATUS_PATH,
    probePath: WORKBUDDY_AI_PROBE_PATH,
  },
  {
    id: 'zcode',
    kind: 'zcode',
    displayName: 'ZCode',
    appName: 'ZCode',
    ownFilename: '.zcode-auth.json',
    probeFilename: '.zcode-probe.json',
    catalogFilename: '.zcode-catalog.json',
    settingsNs: 'anyconnect-zcode' as SettingsNamespace,
    statusPath: ZCODE_STATUS_PATH,
    probePath: ZCODE_PROBE_PATH,
  },
]

/** All provider variants, in registration order. */
export const PROVIDER_VARIANTS = WORKBUDDY_VARIANTS

/** The CN variant; the plugin's long-standing default and compatibility anchor. */
export const CN_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[0]!

/** The international variant. */
export const AI_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[1]!

/** The GLM Coding Plan variant. */
export const ZCODE_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[2]!

/** Look up a variant by provider id. */
export function variantFor(id: string): WorkBuddyVariant | undefined {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}
