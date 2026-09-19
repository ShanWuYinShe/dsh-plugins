/**
 * WorkBuddy credential resolution. The primary source is the WorkBuddy
 * desktop app's own auth file, read-only; a plugin-owned copy under
 * `$DSH_HOME` holds token refreshes so the desktop file is never written.
 * The effective credential is whichever of the two expires later, so a
 * refresh by either side wins.
 *
 * @module dsh-any-connect/auth
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { regionOf } from './upstream.js'
import type { WorkBuddyRefreshOutcome } from './upstream.js'
import type { WorkBuddyVariant } from './variants.js'

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
   * "nobody signed in" — a region mismatch being the case that matters.
   * Present only on `signed-out`, and never a substitute for fixing the file.
   */
  reason?: string
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyStoreOptions {
  /** Product variant served by this store; selects filenames, env var, and
   * the accepted credential region. Absent means the CN default, so every
   * existing invocation keeps its behaviour. */
  variant?: WorkBuddyVariant
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
}

/** A credential belonging to the other product was refused. Callers treat it
 * as signed-out (hiding the group) rather than retrying: no retry will fix a
 * wrong-region file. */
export class RegionMismatchError extends Error {}

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

/** 刷新响应缺 expiresIn 时新 access token 的保守寿命下限(10 分钟):
 * 沿用旧过期时间会让 needsRefresh 恒真、每条请求都打一次刷新端点。 */
const DEFAULT_EXPIRES_IN_SEC = 10 * 60

/** 两次刷新之间的最小间隔:极短有效期/缺 expiresIn 的上游响应 otherwise
 * 会把刷新端点打成每请求一次;窗口内 token 未真正过期时直接用现值。 */
const MIN_REFRESH_INTERVAL_MS = 30_000

/** 「token 剩余寿命长于这个值就容忍一次刷新失败/无 refresh token」的下限。
 *  与 MIN_REFRESH_INTERVAL_MS 同值但语义不同(节流窗口 vs 可容忍寿命),
 *  两者不得互相替代。 */
const MIN_REUSABLE_LIFETIME_MS = 30_000

/** refreshMarginMs 的默认值(5 分钟):文档承诺 "default five minutes"。 */
const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: WorkBuddyCredential
}

/** Plugin-owned copy path inside the Harness home. */
export function workbuddyOwnAuthPath(filename: string = WORKBUDDY_AUTH_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** Directory portion of the desktop auth path, shared by both products. */
const DESKTOP_AUTH_DIR_PARTS = ['CodeBuddyExtension', 'Data', 'Public', 'auth'] as const

const DESKTOP_AUTH_RELATIVE_PATH = [...DESKTOP_AUTH_DIR_PARTS, 'workbuddy-desktop.info'] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH),
  ]
}

/**
 * Platform-default candidates for the WorkBuddy desktop app's auth file, in
 * probe order. Windows probes both AppData roots: current builds write under
 * `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
 * those same Windows locations through its mounted Windows profile before the
 * native Linux location.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
      join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    ]
  }
  if (process.platform === 'linux') {
    const linux = join(home, '.config', ...DESKTOP_AUTH_RELATIVE_PATH)
    return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux]
  }
  return []
}

/**
 * Platform-default candidates for one variant, in probe order: the CN probe
 * order with the basename swapped for the variant's file. Both apps share the
 * auth directory and differ only by filename, so every platform branch is
 * reused rather than reimplemented.
 */
export function desktopAuthCandidatesFor(variant: WorkBuddyVariant): string[] {
  // desktopFilename is WorkBuddy-only by construction: only WorkBuddy
  // variants ever reach the shared auth-directory probe order.
  return defaultDesktopAuthCandidates().map(path => join(dirname(path), variant.desktopFilename!))
}

/** First platform-default candidate for one variant, for diagnostics. */
export function defaultDesktopAuthPath(variant?: WorkBuddyVariant): string | undefined {
  const candidates = variant === undefined ? defaultDesktopAuthCandidates() : desktopAuthCandidatesFor(variant)
  return candidates[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAuth(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  const credential: WorkBuddyCredential = {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
  return credential
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text: string): WorkBuddyCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const raw = document['credential'] as Record<string, unknown>
  // parseWorkBuddyAuth 认桌面文件的 expiresAt/refreshExpiresAt 拼写,而自有
  // 副本直接序列化 WorkBuddyCredential(字段名带 Ms 后缀)——这一不对称曾让
  // 副本每次读回 expiresAtMs=0,needsRefresh 恒真,每条请求都打一次刷新
  // 端点。序列化前补上桌面拼写别名,存量副本(只带 Ms 字段)同样解析。
  const authLike = 'expiresAt' in raw ? raw : {
    ...raw,
    'expiresAt': raw['expiresAtMs'],
    ...'refreshExpiresAtMs' in raw ? { 'refreshExpiresAt': raw['refreshExpiresAtMs'] } : {},
  }
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: authLike }))
  if (credential === undefined) return undefined
  return { ...credential, source: 'dsh' }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

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
  private readonly variant: WorkBuddyVariant | undefined
  private readonly refresh: WorkBuddyStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private readonly onWarning: (message: string) => void
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyCredential> | undefined
  /** 落盘失败时的内存兜底:承载着可能已被上游轮换的 refresh token,
   * 比磁盘副本新时 {@link current} 优先返回它,进程退出即失。 */
  private memoryCredential: WorkBuddyCredential | undefined
  /** 上一次刷新尝试（无论成败）的时刻；{@link MIN_REFRESH_INTERVAL_MS} 内
   *  不再发起尝试。失败也计入——否则刷新端点持续故障且 token 还在 margin
   *  内时，每条请求都会打一次刷新端点（与要防的「极短有效期打爆端点」
   *  同构，只是发生在失败侧）。 */
  private lastRefreshAttemptMs = 0
  /** 上一次刷新**失败**的时刻。token 已过期时 {@link resolve} 无法像未过期
   *  那样直接复用现值，必须另用本字段保住失败退避：否则刷新端点故障 + 过期
   *  的最坏组合下，节流被完全绕过，每条请求都串行等一次刷新超时才失败。 */
  private lastRefreshFailureMs = 0

  constructor(options: WorkBuddyStoreOptions) {
    this.variant = options.variant
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS
    this.ownPath = options.ownPath ?? (options.variant === undefined
      ? workbuddyOwnAuthPath()
      : workbuddyOwnAuthPath(options.variant.ownFilename))
    this.desktopPathOverride = options.desktopPath
    this.onWarning = options.onWarning ?? (message => console.warn(message))
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[this.variant?.env ?? WORKBUDDY_AUTH_FILE_ENV]
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
    return this.variant === undefined
      ? defaultDesktopAuthCandidates()
      : desktopAuthCandidatesFor(this.variant)
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
    if (this.variant !== undefined) {
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
    const stored = desktop === undefined
      ? own
      : own === undefined ? desktop : (own.expiresAtMs > desktop.expiresAtMs ? own : desktop)
    // 落盘失败期间的内存兜底:它承载着可能已轮换的 refresh token,比磁盘
    // 副本新时优先;桌面端此后若刷新出更新的凭据则自然回落桌面文件。
    if (this.memoryCredential !== undefined
      && (stored === undefined || this.memoryCredential.expiresAtMs > stored.expiresAtMs)) {
      return this.memoryCredential
    }
    return stored
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
      throw new Error(
        `workbuddy: no signed-in WorkBuddy account found; sign in once in the WorkBuddy desktop app`
        + ` (expected ${desktop} or WORKBUDDY_AUTH_FILE), or refresh an existing session`,
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
    if (Date.now() - this.lastRefreshAttemptMs < MIN_REFRESH_INTERVAL_MS) {
      if (credential.expiresAtMs > Date.now()) return credential
      if (Date.now() - this.lastRefreshFailureMs < MIN_REFRESH_INTERVAL_MS) {
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
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch (error: unknown) {
      // A refused credential (wrong region) is a report, not a plain
      // signed-out: the card renders the reason in place of the generic hint.
      if (error instanceof RegionMismatchError) return { state: 'signed-out', reason: error.message }
      return { state: 'signed-out' }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    this.memoryCredential = undefined
    this.lastRefreshAttemptMs = 0
    this.lastRefreshFailureMs = 0
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  private needsRefresh(credential: WorkBuddyCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + MIN_REUSABLE_LIFETIME_MS) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    let outcome: WorkBuddyRefreshOutcome
    try {
      outcome = await this.refresh(credential)
    } catch (error: unknown) {
      // 失败同样计入节流窗口（见 lastRefreshAttemptMs / lastRefreshFailureMs）。
      this.lastRefreshAttemptMs = Date.now()
      this.lastRefreshFailureMs = this.lastRefreshAttemptMs
      if (credential.expiresAtMs > Date.now() + MIN_REUSABLE_LIFETIME_MS) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
    this.lastRefreshAttemptMs = Date.now()
    const refreshed: WorkBuddyCredential = {
      ...credential,
      accessToken: outcome.accessToken,
      ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
      // 上游省略 expiresIn 时不能沿用旧过期时间:旧值必然已在刷新 margin
      // 内(否则不会走到这里),沿用会让 needsRefresh 恒真、每条请求都触发
      // 刷新。按保守下限外推;若真实寿命更短,后续请求的失败路径仍会再次
      // 尝试刷新。
      expiresAtMs: outcome.expiresInSec !== undefined
        ? Date.now() + outcome.expiresInSec * 1000
        : Date.now() + DEFAULT_EXPIRES_IN_SEC * 1000,
      ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
      source: 'dsh',
    }
    try {
      await this.saveOwn(refreshed)
      this.memoryCredential = undefined
    } catch (error: unknown) {
      // 落盘失败绝不丢刷新成果:上游可能已把 refresh token 轮换为一次性
      // 新值,退回磁盘上的旧副本会让下一次刷新必然 session_dead。内存兜底
      // 让本进程继续用新凭据,并把真实原因(磁盘写失败,而非上游刷新失败)
      // 送告警通道。
      this.memoryCredential = refreshed
      this.onWarning(
        'workbuddy: token refreshed but saving the plugin-owned copy failed'
        + ` (${String(error)}); the refreshed token is kept in memory only and will be lost on exit`,
      )
    }
    return refreshed
  }

  private async saveOwn(credential: WorkBuddyCredential): Promise<void> {
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file
   * (ENOENT) falls through to the next candidate; a file that is present
   * but unparsable is authoritative for its slot, so a stale older-version
   * file never silently wins over a broken newer one.
   */
  private async readDesktop(): Promise<WorkBuddyCredential | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        return parseWorkBuddyAuth(await readFile(desktopPath, 'utf8'))
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return undefined
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

  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(desktopPath)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }
}
