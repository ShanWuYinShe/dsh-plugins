/**
 * auth-types.ts — 凭据、鉴权状态与存储选项的类型，以及区域错配错误。
 *
 * 2026-10-08 从 1160 行的 auth.ts 拆出：类型、路径解析、ZCode 解析、文档解析与
 * 存储类原本在一个文件里。auth.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/auth-types
 */

import type { WorkBuddyRefreshOutcome } from './upstream.js'
import type { WorkBuddyVariant } from './variants.js'
import type { WorkBuddyAtRestKeyProvider, WorkBuddySignedOutReasonCode } from './desktop-credential-protection.js'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
  /**
   * Which plan the ZCode client has selected for this account, read from the
   * `setting.json` beside the credentials file — then normalized by the
   * store's plan-override hook, so this field is the plan **in force**: the
   * value every consumer (model routing, quota source, night-free
   * eligibility) branches on.
   *
   * The same credentials document can hold several account keys (team,
   * individual, start plan), so the selected plan — not the document order —
   * is what says which one a request must authenticate with. Account plans
   * (`start-plan` / `off-peak`) carry no key of their own: they are served by
   * the account's coding-plan key on the ordinary ZCode channel.
   */
  zcodePlan?: ZCodePlanKind
  /**
   * The decrypted `zcodejwttoken`: the account-plan credential that
   * authenticates the Start Plan–specific channel (dedicated quota, same-day
   * validity). Present when the credentials document carries one, regardless
   * of the plan in force.
   */
  zcodeJwtToken?: string
  /**
   * Stable per-install device id (`X-Device-Mid`) read from the desktop
   * client's telemetry state beside the credentials file; the account-plan
   * endpoints hard-require it.
   */
  zcodeDeviceMid?: string
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
  /**
   * Why no credential is usable, when that is diagnosable rather than simply
   * "nobody signed in" — a region mismatch, an unreadable 5.6 envelope, or a
   * missing Electron helper being the cases that matter. Present only on
   * `signed-out`, and never a substitute for fixing the file.
   */
  reason?: string
  /**
   * Machine-readable companion to {@link reason}, for callers that must branch
   * on the cause. Never derived by matching `reason` text.
   */
  reasonCode?: WorkBuddySignedOutReasonCode
}

/** Constructor options; {@link refresh} and {@link variant} are required. */
export interface WorkBuddyStoreOptions {
  /** Product variant served by this store; selects filenames, env var, and
   * the accepted credential region. */
  variant: WorkBuddyVariant
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyCredential) => Promise<WorkBuddyRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
  /** Non-fatal warning channel (e.g. the owned-copy save failing after a
   * successful refresh); defaults to `console.warn`. */
  onWarning?: (message: string) => void
  /**
   * Final normalization applied to every credential this store hands out
   * (desktop, plugin copy, or in-memory). The ZCode variant uses it to fold
   * the card's plan override into the credential, so every consumer sees the
   * plan actually in force. Must stay pure; failures here would poison every
   * read.
   */
  transformCredential?: (credential: WorkBuddyCredential) => WorkBuddyCredential
  /**
   * Resolver for WorkBuddy 5.6's at-rest protector key, needed when the
   * desktop file stores its token fields in `$wbEncrypted` envelopes.
   * Defaults to the real provider for WorkBuddy variants — which spawns the
   * app's own Electron binary — so the plugin host and the CLI can never
   * disagree about which binary a variant resolves. Tests stand in a stub, and
   * the ZCode variants never read an encrypted document.
   */
  keyProvider?: Pick<WorkBuddyAtRestKeyProvider, 'protectorKeyFor' | 'helperPath'>
}

/** A credential belonging to the other product was refused. Callers treat it
 * as signed-out (hiding the group) rather than retrying: no retry will fix a
 * wrong-region file. */
export class RegionMismatchError extends Error {}

/** Family a ZCode account provider belongs to; mirrors the client's own enum. */
export type ZCodeFamily = 'bigmodel' | 'zai'

/**
 * Which plan a ZCode account provider serves. Mirrors the client's own enum,
 * so the value read out of `setting.json` is used verbatim.
 */
export type ZCodePlanKind = 'individual-coding-plan' | 'team-coding-plan' | 'start-plan' | 'off-peak'
