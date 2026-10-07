/**
 * The providers this one plugin serves: the two WorkBuddy desktop apps (CN +
 * international).
 *
 * Ported from corrinehu/dsh-workbuddy-connect `src/variants.ts` (MIT),
 * adapted to this package's naming (`anyconnect` settings namespaces,
 * `/plugins/dsh-any-connect` routes). Both products are the same client
 * framework in different regions, and both write their sign-in into the
 * *same* shared `CodeBuddyExtension` auth directory — they differ by file
 * basename, base URL, catalog endpoint, and display identity.
 *
 * @module dsh-any-connect/variants
 */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  WORKBUDDY_AI_PROBE_PATH,
  WORKBUDDY_AI_STATUS_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_STATUS_PATH,
  ZCODE_PROBE_PATH,
  ZCODE_SP_PROBE_PATH,
  ZCODE_SP_STATUS_PATH,
  ZCODE_STATUS_PATH,
} from './status-paths.js'
import { WORKBUDDY_AI_CATALOG_FILENAME, WORKBUDDY_CATALOG_FILENAME } from './catalog-store.js'
import type { WorkBuddyRegion } from './upstream.js'

/** Which upstream family a variant talks to; selects the per-kind wiring. */
export type VariantKind = 'workbuddy' | 'zcode'

/**
 * How one WorkBuddy product's Electron binary is identified and located, and
 * which env var names an explicit one (ported from corrinehu/dsh-workbuddy-connect,
 * MIT; upstream issues #59/#60).
 *
 * Identity is per product — bundle id, uninstall-registry DisplayName, exe
 * basename — so a search for one app can never execute the other's binary.
 * WorkBuddy 5.6 encrypts its desktop credential fields, and the at-rest key
 * only exists inside the app's own Electron, so this is what the credential
 * store needs to unlock a signed-in desktop app (see
 * {@link WorkBuddyCredentialStore}).
 */
export interface WorkBuddyElectronProduct {
  /** Product name for helper diagnostics and error copy, e.g. `WorkBuddy AI`. */
  productName: string
  /** Env var naming an explicit Electron binary for this product alone. */
  envVar: string
  /** macOS identity and default install layout, verified per product. */
  macOS: {
    bundleId: string
    defaultPath: string
  }
  /**
   * Windows identity from the uninstall registry and the exe it names.
   * `defaultPathSegments` exists only where the default install location has
   * been measured (CN); the international app has only been seen in
   * user-chosen locations, so it stays registry-only — an unverified default
   * is a guess, and guessing is how the wrong app gets executed.
   */
  windows: {
    displayNamePattern: RegExp
    exeBasename: string
    defaultPathSegments?: readonly string[]
  }
}

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
  /** Env var overriding the desktop auth-file location. */
  env?: string
  /**
   * How this variant's Electron helper is located, for the WorkBuddy 5.6
   * at-rest credential format. Absent for the ZCode variants, which read a
   * plaintext credentials document and never need the helper; resolution for
   * descriptors assembled elsewhere falls back by variant id (see
   * {@link electronProfileFor}).
   */
  electron?: WorkBuddyElectronProduct
  /** Basename of the desktop app's own auth file in the shared auth directory. */
  desktopFilename?: string
  /** Basename of the plugin-owned credential copy under `$DSH_HOME`. */
  ownFilename: string
  /** Basename of the plugin-owned probe-record file under `$DSH_HOME`. */
  probeFilename: string
  /**
   * Basename of the plugin-owned saved-catalog file under `$DSH_HOME`.
   *
   * One per variant: different endpoints disagree about rates,
   * windows, and which models exist for a shared id.
   */
  catalogFilename: string
  /** Settings namespace owning this variant's configuration card. */
  settingsNs: SettingsNamespace
  /** Same-origin status route consumed by this variant's card. */
  statusPath: string
  /** Same-origin probe-control route consumed by this variant's card. */
  probePath: string
  /**
   * ZCode variants only: which account plan this variant IS. The two ZCode
   * plans are separate products, not modes of one connection (2026-09-30
   * 口径) — each variant pins its own plan semantics end to end: model
   * channel (dedicated `zcode-plan/anthropic` vs ordinary BigModel), quota
   * pool (same-day token bucket vs coding-plan subscription), and night-free
   * eligibility. Both variants read the same desktop credentials document;
   * the store's transform folds the plan into every credential they read.
   */
  zcodePlanMode?: 'coding' | 'start'
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
    electron: {
      productName: 'WorkBuddy',
      envVar: 'WORKBUDDY_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.tencent.workbuddy.mac',
        defaultPath: '/Applications/WorkBuddy.app/Contents/MacOS/Electron',
      },
      windows: {
        displayNamePattern: /^WorkBuddy(?:[ ][0-9]+(?:[.][0-9]+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'workbuddy.exe',
        // Measured 5.6.2 install layout: %LOCALAPPDATA%/Programs/WorkBuddy.
        defaultPathSegments: ['Programs', 'WorkBuddy', 'WorkBuddy.exe'],
      },
    },
    desktopFilename: 'workbuddy-desktop.info',
    ownFilename: '.workbuddy-auth.json',
    probeFilename: '.workbuddy-probe.json',
    catalogFilename: WORKBUDDY_CATALOG_FILENAME,
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
    electron: {
      productName: 'WorkBuddy AI',
      envVar: 'WORKBUDDY_AI_ELECTRON_BIN',
      macOS: {
        bundleId: 'com.workbuddy.workbuddy-ai',
        defaultPath: '/Applications/WorkBuddy AI.app/Contents/MacOS/Electron',
      },
      windows: {
        // The CN pattern cannot match this value ("AI" is not a version) and
        // this pattern cannot match the CN record (missing the literal " AI"),
        // so the two records never feed each other's discovery.
        displayNamePattern: /^WorkBuddy AI(?:[ ][0-9]+(?:[.][0-9]+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
        exeBasename: 'workbuddyai.exe',
      },
    },
    desktopFilename: 'workbuddy-desktop-ai.info',
    ownFilename: '.workbuddy-ai-auth.json',
    probeFilename: '.workbuddy-ai-probe.json',
    catalogFilename: WORKBUDDY_AI_CATALOG_FILENAME,
    settingsNs: 'anyconnect-ai' as SettingsNamespace,
    statusPath: WORKBUDDY_AI_STATUS_PATH,
    probePath: WORKBUDDY_AI_PROBE_PATH,
  },
]

/** ZCode (Coding Plan) provider variant: the ordinary BigModel channel. */
export const ZCODE_VARIANT: WorkBuddyVariant = {
  id: 'zcode',
  kind: 'zcode',
  displayName: 'ZCode',
  appName: 'ZCode',
  env: 'ZCODE_AUTH_FILE',
  desktopFilename: 'credentials.json',
  ownFilename: '.zcode-auth.json',
  probeFilename: '.zcode-probe.json',
  catalogFilename: '.zcode-catalog.json',
  settingsNs: 'anyconnect-zcode' as SettingsNamespace,
  statusPath: ZCODE_STATUS_PATH,
  probePath: ZCODE_PROBE_PATH,
  zcodePlanMode: 'coding',
}

/**
 * ZCode Start Plan provider variant: the account-plan's own dedicated channel
 * and quota pool. A separate product, not a mode of {@link ZCODE_VARIANT} —
 * it shares the desktop credentials document (the plan's material lives in
 * the same file: `zcodejwttoken`, device id) but nothing else: own routes,
 * own card, own model roster, own catalog/probe files.
 */
export const ZCODE_START_PLAN_VARIANT: WorkBuddyVariant = {
  id: 'zcode-start-plan',
  kind: 'zcode',
  displayName: 'ZCode Start Plan',
  appName: 'ZCode',
  env: 'ZCODE_AUTH_FILE',
  desktopFilename: 'credentials.json',
  ownFilename: '.zcode-sp-auth.json',
  probeFilename: '.zcode-sp-probe.json',
  catalogFilename: '.zcode-sp-catalog.json',
  settingsNs: 'anyconnect-zcode-sp' as SettingsNamespace,
  statusPath: ZCODE_SP_STATUS_PATH,
  probePath: ZCODE_SP_PROBE_PATH,
  zcodePlanMode: 'start',
}

/** All provider variants, in registration order. */
export const PROVIDER_VARIANTS: readonly WorkBuddyVariant[] = [
  ...WORKBUDDY_VARIANTS,
  ZCODE_VARIANT,
  ZCODE_START_PLAN_VARIANT,
]

/** The CN variant; the plugin's long-standing default and compatibility anchor. */
export const CN_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[0]!

/** The international variant. */
export const AI_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANTS[1]!

/** Look up a variant by provider id. */
export function variantFor(id: string): WorkBuddyVariant | undefined {
  return PROVIDER_VARIANTS.find(variant => variant.id === id)
}

/**
 * The Electron profile a WorkBuddy variant resolves its at-rest key helper
 * with.
 *
 * A descriptor assembled outside this module may omit `electron`; resolution
 * then falls back by variant id, so an unknown custom variant stays on the CN
 * product. The ZCode variants never reach this: they read a plaintext
 * credential document and have no Electron helper.
 */
export function electronProfileFor(variant: Pick<WorkBuddyVariant, 'id' | 'electron'> | undefined): WorkBuddyElectronProduct {
  return variant?.electron ?? (variant?.id === AI_VARIANT.id ? AI_VARIANT : CN_VARIANT).electron!
}
