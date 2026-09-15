/**
 * The two WorkBuddy desktop apps this one plugin serves.
 *
 * Ported from corrinehu/dsh-workbuddy-connect `src/variants.ts` (MIT),
 * adapted to this package's naming (`anyconnect` settings namespaces,
 * `/plugins/dsh-any-connect` routes).
 *
 * Both products are the same client framework in different regions, and both
 * write their sign-in into the *same* shared `CodeBuddyExtension` auth
 * directory — they differ by file basename, base URL, catalog endpoint, and
 * display identity. Everything that varies between them is collected here as
 * one descriptor, so no module has to carry its own `if (international)`
 * branch and a third variant would be a data change rather than a refactor.
 *
 * @module dsh-any-connect/variants
 */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from './status-paths.js'
import type { WorkBuddyRegion } from './upstream.js'

/** One WorkBuddy product variant. */
export interface WorkBuddyVariant {
  /** Provider id registered with DSH, e.g. `workbuddy-ai`. */
  id: string
  /** Model-group heading and card title stem, e.g. `WorkBuddy AI`. */
  displayName: string
  /** Desktop app name as users know it, for diagnostics and error copy. */
  appName: string
  /** Which upstream region this variant's credentials must belong to. */
  region: WorkBuddyRegion
  /** Env var overriding the desktop auth-file location. */
  env: string
  /** Basename of the desktop app's own auth file in the shared auth directory. */
  desktopFilename: string
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string
  /**
   * Basename of the plugin-owned saved-catalog file under `$DSH_HOME`.
   *
   * One per variant: the two endpoints disagree about rates, windows, and
   * even which models exist for a shared id, so a catalog saved from one
   * must never be served as the other's.
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
]

/** The CN variant; the plugin's long-standing default and compatibility anchor. */
export const CN_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[0]!

/** The international variant. */
export const AI_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[1]!

/** Look up a variant by provider id. */
export function variantFor(id: string): WorkBuddyVariant | undefined {
  return WORKBUDDY_VARIANTS.find(variant => variant.id === id)
}
