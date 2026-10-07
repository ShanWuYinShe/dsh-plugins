/**
 * auth-store.ts — 凭据存储：解析、刷新节流、落盘与注销。
 *
 * 2026-10-08 从 1160 行的 auth.ts 拆出：类型、路径解析、ZCode 解析、文档解析与
 * 存储类原本在一个文件里。auth.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/auth-store
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { regionOf } from './upstream.js'
import type { WorkBuddyVariant } from './variants.js'
import {
  atRestKeyProviderFor,
  reasonCodeOf,
  type DesktopAuthFormat,
} from './desktop-credential-protection.js'
import { RegionMismatchError } from './auth-types.js'
import type { WorkBuddyCredential, WorkBuddyAuthStatus, WorkBuddyStoreOptions } from './auth-types.js'
import { WORKBUDDY_AUTH_FILE_ENV, workbuddyOwnAuthPath, desktopAuthCandidatesFor } from './auth-paths.js'
import { parseZCodeAuth } from './auth-zcode.js'
import { parseOwnDocument } from './auth-document.js'
import { needsRefresh, refreshNow, saveOwn, type RefreshContext, type RefreshState } from './auth-refresh.js'
import { atRestHelperPath, desktopAuthFormat, desktopFilePresent, resolvedDesktopAuthPath, type DesktopInspectContext } from './auth-desktop-inspect.js'
import { readDesktopCredential } from './auth-desktop-read.js'

/** 两次刷新之间的最小间隔:极短有效期/缺 expiresIn 的上游响应 otherwise
 * 会把刷新端点打成每请求一次;窗口内 token 未真正过期时直接用现值。 */
const MIN_REFRESH_INTERVAL_MS = 30_000

/** refreshMarginMs 的默认值(5 分钟):文档承诺 "default five minutes"。 */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000

/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin
 * (or already expired), keep the refreshed credential in the plugin-owned
 * copy, and never write the desktop app's file. A failed refresh still
 * returns a not-yet-expired token so an unreachable refresh endpoint does
 * not take down a working session.
 */
export class WorkBuddyCredentialStore {
  private readonly variant: WorkBuddyVariant
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private readonly onWarning: (message: string) => void
  private readonly transformCredential?: WorkBuddyStoreOptions['transformCredential']
  /**
   * Resolver for WorkBuddy 5.6's at-rest protector key. Absent for the ZCode
   * variants, whose credentials document is plaintext and never encrypted.
   */
  private readonly keyProvider: WorkBuddyStoreOptions['keyProvider']
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined
  /** 刷新节流与内存兜底状态（由 auth-refresh 读写）。 */
  private readonly refreshState: RefreshState = { memoryCredential: undefined, lastRefreshAttemptMs: 0, lastRefreshFailureMs: 0 }

  constructor(options: WorkBuddyStoreOptions) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS
    this.ownPath = options.ownPath ?? workbuddyOwnAuthPath(options.variant.ownFilename)
    this.desktopPathOverride = options.desktopPath
    this.onWarning = options.onWarning ?? (message => console.warn(message))
    this.transformCredential = options.transformCredential
    // Defaulting here (rather than requiring every composition root to pass it)
    // is what keeps the plugin host and the CLI identical: both build a store
    // the same way, so `doctor` can never describe a different binary than the
    // one the provider would actually spawn.
    this.keyProvider = options.keyProvider
      ?? (options.variant.kind === 'workbuddy' ? atRestKeyProviderFor(options.variant) : undefined)
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[this.variant.env ?? WORKBUDDY_AUTH_FILE_ENV]
    // The settings schema materializes an unset `authFile` as an empty
    // string, and `onChange` hands that string here verbatim. A blank
    // override must fall through to the platform probe order exactly like a
    // blank env var does — otherwise a fresh install probes a single empty
    // path, finds nothing, and the whole plugin reads as signed out.
    const fromConfig = this.desktopPathOverride !== undefined && this.desktopPathOverride.trim() !== ''
      ? this.desktopPathOverride
      : undefined
    const explicit = fromConfig ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return desktopAuthCandidatesFor(this.variant)
  }

  private resolveDesktopPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /**
   * Repoint the desktop file; a settings change applies on the next read.
   */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopPath()
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<WorkBuddyCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    // A credential belonging to the other product is refused rather than used:
    // the two apps share one auth directory and differ only by filename, so a
    // misconfigured `authFile` / env var is a realistic mistake, and sending one
    // region's token to the other's endpoint would leak it across products.
    // Naming the file and the expected region is what makes it fixable.
    if (this.variant.region !== undefined) {
      for (const [label, credential] of [['desktop file', desktop], ['plugin copy', own]] as const) {
        if (credential === undefined) continue
        const region = regionOf(credential.domain)
        if (region !== this.variant.region) {
          throw new RegionMismatchError(
            `${this.variant.displayName} received a ${region === 'cn' ? 'WorkBuddy (CN)' : 'WorkBuddy AI'} credential`
            + ` in its ${label} (domain ${JSON.stringify(credential.domain)});`
            + ` point ${this.variant.env} at the ${this.variant.appName} sign-in, or remove the mismatched file`,
          )
        }
      }
    }
    // 桌面文件是「现在是谁登录」的权威:自有副本可能属于上一个账号——它甚至
    // 可能因为插件刷新过而过期更晚,只按过期时间择优会把上一个账号的 token
    // (连同一个 uid)发给上游。身份不一致时一律以桌面文件为准,与时间无关。
    const identityDiffers = desktop !== undefined && own !== undefined
      && (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId)
    const stored = desktop === undefined
      ? own
      : own === undefined || identityDiffers ? desktop : (own.expiresAtMs > desktop.expiresAtMs ? own : desktop)
    // 落盘失败期间的内存兜底:它承载着可能已轮换的 refresh token,比磁盘
    // 副本新时优先;但同样只在身份一致时——账号已在桌面端切换后,内存里的
    // 旧账号凭据不得盖过新身份。桌面端此后若刷新出更新的凭据则自然回落。
    const memoryCredential = this.refreshState.memoryCredential
    const memoryUsable = memoryCredential !== undefined
      && (stored === undefined
        || (memoryCredential.uid === stored.uid
          && memoryCredential.enterpriseId === stored.enterpriseId
          && memoryCredential.expiresAtMs > stored.expiresAtMs))
    const effective = memoryUsable ? memoryCredential : stored
    if (effective === undefined) return undefined
    return this.transformCredential === undefined ? effective : this.transformCredential(effective)
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      const app = this.variant.appName
      throw new Error(
        `${this.variant.id}: no signed-in ${app} account found; sign in once in the ${app} desktop app`
        + ` (expected ${desktop} or ${this.variant.env ?? WORKBUDDY_AUTH_FILE_ENV}), or refresh an existing session`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    // 刷新节流:needsRefresh 只看过期时间,上游签发极短有效期(或刷新
    // 响应缺 expiresIn)会让每条请求都打一次刷新端点——单飞只合并并发、
    // 不节流。窗口内且 token 尚未真正过期时直接用现值;已过期则必须尝试,
    // 但若窗口内的上一次尝试就是失败,同样退避(快速失败)——刷新成果会让
    // needsRefresh 变假,走不到这里,因此窗口内「已过期」基本只剩失败一种
    // 来源;成功刷新出的极短有效期 token 由 lastRefreshFailureMs 已过期
    // (陈旧)放行,下一条请求即重试刷新。
    if (Date.now() - this.refreshState.lastRefreshAttemptMs < MIN_REFRESH_INTERVAL_MS) {
      if (credential.expiresAtMs > Date.now()) return credential
      if (Date.now() - this.refreshState.lastRefreshFailureMs < MIN_REFRESH_INTERVAL_MS) {
        throw new Error(
          'workbuddy: token refresh failed recently and the access token is expired;'
          + ' retry in a moment, or open the WorkBuddy desktop app once to sign in again',
        )
      }
    }
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out', reasonCode: 'no-credential' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch (error: unknown) {
      // 每个可诊断的失败都是一份报告,而不是笼统的 signed-out:区域不符、5.6
      // 信封解不开、WorkBuddy 的 Electron 定位不到,各自有可执行的修法,卡片
      // 直接渲染 reason;reasonCode 让调用方按成因分支而不必匹配文案。
      const reasonCode = error instanceof RegionMismatchError
        ? 'credential-region-mismatch' as const
        : reasonCodeOf(error)
      return {
        state: 'signed-out',
        reason: error instanceof Error ? error.message : String(error),
        ...reasonCode === undefined ? {} : { reasonCode },
      }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    // 先等在途刷新结束再动手:refreshNow 成功路径会无条件把刷新结果
    // saveOwn 回插件自有副本,不等的话「登出」会被随后落盘的刷新成果
    // 原样复活(文件回来了,用户表现为仍登录)。rejection 吞掉——刷新
    // 失败不阻止登出,反而正该删。内存清理也放在 await 之后:refreshNow
    // 的失败路径会把刷新结果兜底进 memoryCredential,先清会被它覆盖。
    const inflight = this.inflight
    if (inflight !== undefined) await inflight.catch(() => {})
    this.refreshState.memoryCredential = undefined
    this.refreshState.lastRefreshAttemptMs = 0
    this.refreshState.lastRefreshFailureMs = 0
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    return needsRefresh(this.refreshContext(), credential)
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    return await refreshNow(this.refreshContext(), credential)
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await saveOwn(this.refreshContext(), credential)
  }

  /** 刷新策略的入参（含调用方持有的节流状态）。 */
  private refreshContext(): RefreshContext {
    return {
      variant: this.variant,
      refresh: this.refresh,
      refreshMarginMs: this.refreshMarginMs,
      ownPath: this.ownPath,
      onWarning: this.onWarning,
      state: this.refreshState,
    }
  }
  /**
   * Read the first desktop candidate that exists.
   *
   * Only an absent file (ENOENT) falls through to the next candidate: a file
   * that is present is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one. Since WorkBuddy 5.6 a
   * token field may arrive in an at-rest envelope, so the text is classified
   * before the regular parser sees it — an encrypted document is *opened*,
   * never skipped, and one this plugin cannot decode fails loudly instead of
   * being papered over by the plugin-owned copy (which may belong to whatever
   * account was signed in when it was last refreshed).
   */
  private readDesktop(): Promise<WorkBuddyCredential | undefined> {
    return readDesktopCredential({
      variant: this.variant,
      candidates: () => this.resolveDesktopCandidates(),
      keyProvider: this.keyProvider,
    })
  }

  private async readOwn(): Promise<WorkBuddyCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch {
      // 有意与 readDesktop 的策略不同:自有副本是唯一可写副本,读失败
      // (缺失/损坏/无权限)一律视为无凭据并静默回落桌面文件——这里抛错
      // 只会让每次 resolve 都失败,而桌面文件通常仍在。
      return undefined
    }
  }

  /**
   * The first desktop candidate authentication would actually read from;
   * `undefined` when none carries content. Diagnostics only, and deliberately
   * the same skip rule as {@link readDesktop}: an empty file is passed over, so
   * a report names the file that really answers rather than a stale
   * placeholder beside it.
   */
  async resolvedDesktopAuthPath(): Promise<string | undefined> {
    return await resolvedDesktopAuthPath(this.desktopInspectContext())
  }

  async desktopAuthFormat(): Promise<DesktopAuthFormat> {
    return await desktopAuthFormat(this.desktopInspectContext())
  }

  atRestHelperPath(): string | undefined {
    return atRestHelperPath(this.desktopInspectContext())
  }

  async desktopFilePresent(): Promise<boolean> {
    return await desktopFilePresent(this.desktopInspectContext())
  }

  /** 诊断检查的入参。 */
  private desktopInspectContext(): DesktopInspectContext {
    return { candidates: () => this.resolveDesktopCandidates(), keyProvider: this.keyProvider }
  }
}
