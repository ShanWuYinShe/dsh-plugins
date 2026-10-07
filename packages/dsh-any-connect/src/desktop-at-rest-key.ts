/**
 * desktop-at-rest-key.ts — at-rest 保护密钥解析器（单飞、仅内存缓存、按 key id 重解析）。
 *
 * 2026-10-08 从 desktop-credential-protection.ts（1196 行）拆出：信封密码学、
 * 跨平台发现共享层、Windows 注册表解析与密钥解析器原本混在一个文件里。现在按
 * 「信封 / 发现共享层 / Windows 发现 / 密钥解析器」四分，
 * desktop-credential-protection.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/desktop-at-rest-key
 */

import { execFile } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { electronProfileFor, type WorkBuddyElectronProduct, type WorkBuddyVariant } from './variants.js'
import { defaultWorkBuddyElectronPath, electronDiscoveryFor, WORKBUDDY_DISCOVERY_BUDGET_MS, workBuddyDiscoveryTools, isExecutable, WorkBuddyElectronPathError, isENOENT, discoveryIncomplete, HELPER_SCRIPT, HELPER_SCRIPT_ARGUMENT_FLAG } from './desktop-discovery.js'
import type { ResolvedKey, WorkBuddyElectronDiscovery, DiscoveredApp, WorkBuddyDiscoveryTools } from './desktop-discovery.js'
import { parseAtRestPayload, deriveProtectorKey } from './desktop-auth-envelope.js'
import { WINDOWS_REGISTRY_ROOTS, workBuddyWindowsDiscoveryTools, parseWindowsRegistryOutput, inspectWindowsElectronCandidate } from './desktop-discovery-windows.js'
import type { WorkBuddyWindowsDiscoveryTools } from './desktop-discovery-windows.js'

/** The spawned helper. Separated from the provider so tests can stand it in. */
export type WorkBuddyKeyPayloadSource = () => Promise<string>

/**
 * The at-rest key provider one variant's store should use. Shared by the
 * plugin host and the CLI entry so the browser card and `doctor`/`status` can
 * never disagree about which binary a variant resolves.
 */
export function atRestKeyProviderFor(variant: Pick<WorkBuddyVariant, 'id' | 'electron'>): WorkBuddyAtRestKeyProvider {
  return new WorkBuddyAtRestKeyProvider({
    product: electronProfileFor(variant),
    discovery: electronDiscoveryFor(),
  })
}

/** Provider options. */
export interface WorkBuddyAtRestKeyProviderOptions {
  /**
   * Which product's Electron this provider resolves. Required and the only
   * source of product identity: it names the explicit-path env var, the bundle
   * id / registry name / exe basename discovery must match, and the platform
   * default. Without it the provider could not even decide which env var to
   * read — the discovery setting alone cannot carry this (both products are
   * `none` on Linux, yet each must read its own variable).
   */
  product: WorkBuddyElectronProduct
  /** Explicit Electron binary; overrides the platform default and env. */
  electronPath?: string
  /** Helper timeout in milliseconds; default 10s. */
  timeoutMs?: number
  /**
   * Where the payload comes from. Defaults to spawning WorkBuddy's own
   * Electron with `ELECTRON_RUN_AS_NODE=1`; tests supply a stand-in so no
   * test ever touches the real binary or a real key. Supplying this replaces
   * path *resolution* too, so tests about resolution use
   * {@link spawnHelper} instead.
   */
  source?: WorkBuddyKeyPayloadSource
  /**
   * Runs the helper at the resolved path. Distinct from {@link source}, which
   * replaces the whole payload path: this seam keeps resolution — explicit
   * config, platform default, discovery — real, so tests can exercise it
   * without spawning anything.
   */
  spawnHelper?: (electronPath: string) => Promise<string>
  /**
   * Automatic discovery budget; defaults to `'none'` (see
   * {@link WorkBuddyElectronDiscovery}). Passed explicitly per variant at the
   * composition root, never inferred from the environment.
   */
  discovery?: WorkBuddyElectronDiscovery
  /**
   * Platform default binary, consulted only when `discovery` is enabled and no
   * explicit path is configured. Injectable so tests can force the fallback
   * branch without moving the real app; `null` means "no default here".
   */
  defaultElectronPath?: string | undefined
  /** Discovery subprocesses; injectable so tests never spawn. */
  tools?: WorkBuddyDiscoveryTools
  /** Windows registry discovery subprocess; injectable so tests never spawn. */
  windowsTools?: WorkBuddyWindowsDiscoveryTools
  /** Platform override for deterministic discovery tests. */
  platform?: NodeJS.Platform
  /**
   * Total budget for one discovery run, covering the search and every
   * candidate check. Injectable so tests can exercise exhaustion without
   * waiting out the production 10s.
   */
  discoveryBudgetMs?: number
}

/**
 * In-memory protector-key resolver: one spawn per key id, single-flight, never
 * persisted. The cache is keyed by the id envelopes ask for, so an envelope
 * sealed under a rotated key triggers exactly one fresh resolution.
 */export class WorkBuddyAtRestKeyProvider {
  /**
   * The explicit binary, when one was configured. `undefined` here means "the
   * caller did not name one", which is what lets discovery run — an explicit
   * path that turns out to be unusable is an error, never a reason to look for
   * a different app.
   */
  private readonly explicitPath: string | undefined
  private readonly product: WorkBuddyElectronProduct
  private readonly defaultPath: string | undefined
  private readonly discovery: WorkBuddyElectronDiscovery
  private readonly tools: WorkBuddyDiscoveryTools
  private readonly windowsTools: WorkBuddyWindowsDiscoveryTools
  private readonly platform: NodeJS.Platform
  private readonly discoveryBudgetMs: number
  private readonly timeoutMs: number
  private readonly source: WorkBuddyKeyPayloadSource
  private readonly spawnHelper: (electronPath: string) => Promise<string>
  /**
   * The path discovery settled on, cached only on success. A failure leaves
   * this unset so the next attempt tries again — the user may install or move
   * the app without restarting DSH.
   */
  private discoveredPath: string | undefined
  private cache: ResolvedKey | undefined
  private inflight: Promise<ResolvedKey> | undefined

  constructor(options: WorkBuddyAtRestKeyProviderOptions) {
    this.product = options.product
    const fromEnv = process.env[options.product.envVar]?.trim()
    const envPath = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv
    // Explicit sources are authoritative and mutually exclusive with
    // discovery: naming a binary means "use this one", so an unusable one is
    // an error, not an invitation to go looking for another app.
    this.explicitPath = options.electronPath ?? envPath
    this.discovery = options.discovery ?? 'none'
    this.platform = options.platform ?? process.platform
    this.defaultPath = this.discovery === 'none'
      ? undefined
      : options.defaultElectronPath === undefined
        ? defaultWorkBuddyElectronPath(options.product, this.platform)
        : options.defaultElectronPath ?? undefined
    this.tools = options.tools ?? workBuddyDiscoveryTools(options.product.macOS.bundleId)
    this.windowsTools = options.windowsTools ?? workBuddyWindowsDiscoveryTools()
    this.discoveryBudgetMs = options.discoveryBudgetMs ?? WORKBUDDY_DISCOVERY_BUDGET_MS
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.spawnHelper = options.spawnHelper ?? (path => this.spawnAt(path))
    this.source = options.source ?? (() => this.spawnPayload())
  }

  /**
   * The binary the default helper would use, for diagnostics.
   *
   * Reports a *discovery result* once one exists, so diagnostics describe what
   * would actually run rather than the default that was bypassed. Discovery
   * itself stays in {@link resolveElectronPath}: this accessor never triggers a
   * search (the constructor must remain I/O-free, and callers may ask before
   * any resolution has happened).
   */
  helperPath(): string | undefined {
    if (this.explicitPath !== undefined) return this.explicitPath
    if (this.discovery === 'none') return undefined
    return this.discoveredPath ?? this.defaultPath
  }

  /**
   * A protector key matching one of the requested envelope key ids. The first
   * id the cache answers wins; otherwise one spawn resolves the current key,
   * which must match a request — a mismatch means the envelopes were sealed by
   * a different install than the one this machine now runs, and no key we can
   * reach will open them.
   */
  async protectorKeyFor(requested: readonly string[]): Promise<Buffer> {
    if (requested.length === 0) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'encrypted desktop credential carries no key ids',
      )
    }
    const cached = this.cache
    if (cached !== undefined && requested.includes(cached.keyId)) return cached.key
    this.inflight ??= this.source().then(text => this.ingest(text))
      .finally(() => {
        this.inflight = undefined
      })
    const resolved = await this.inflight
    if (!requested.includes(resolved.keyId)) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential's envelope (id ${requested.join(' or ')});`
        + ' the desktop credential was sealed by a different WorkBuddy installation',
      )
    }
    return resolved.key
  }

  private ingest(text: string): ResolvedKey {
    const payload = parseAtRestPayload(text)
    if (payload === undefined) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'WorkBuddy key helper returned an unusable at-rest payload (expected {version:1, atRestSecretKey})',
      )
    }
    const key = deriveProtectorKey(payload.atRestSecretKey)
    const resolved: ResolvedKey = {
      key,
      keyId: createHash('sha256').update(key).digest('hex').slice(0, 16),
    }
    this.cache = resolved
    return resolved
  }

  /**
   * The binary to spawn, or a diagnosable error saying why there is none.
   *
   * Order is the contract: an explicit path is used as-is and never falls back;
   * discovery runs only for a provider that was configured for it, and only
   * after the platform default has been tried and found unusable.
   */
  private async resolveElectronPath(): Promise<string> {
    if (this.explicitPath !== undefined) {
      if (!isExecutable(this.explicitPath)) {
        throw new WorkBuddyElectronPathError(
          'electron-path-invalid',
          `the configured ${this.product.productName} Electron binary is not available at ${this.explicitPath};`
          + ` check ${this.product.envVar} or unset it to let the plugin look for the app itself`,
        )
      }
      return this.explicitPath
    }
    if (this.discovery === 'none') {
      // A platform without a verified layout: "not configured", never "we
      // searched and failed".
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    // The default path is the ordinary case and costs one stat; discovery is
    // reserved for the installations the default misses.
    if (this.defaultPath !== undefined && isExecutable(this.defaultPath)) return this.defaultPath
    // A previously discovered path is re-checked rather than trusted: the app
    // may have been moved or removed since, and a stale path must not win.
    if (this.discoveredPath !== undefined) {
      if (isExecutable(this.discoveredPath)) return this.discoveredPath
      this.discoveredPath = undefined
    }
    const found = this.discovery === 'macos-workbuddy'
      ? await this.discoverMacosApp()
      : await this.discoverWindowsApp()
    this.discoveredPath = found
    return found
  }

  /**
   * Resolve this product's app through Spotlight, then prove each candidate's
   * identity before it can be executed.
   *
   * The whole flow shares one budget: a hang in one candidate must not extend
   * the wait for the others, and running out of budget is reported as an
   * unfinished check rather than an absent app.
   */
  private async discoverMacosApp(): Promise<string> {
    if (this.platform !== 'darwin') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      let candidates: readonly string[]
      try {
        candidates = await this.tools.findApps(controller.signal)
      } catch {
        throw discoveryIncomplete(this.product.productName, 'the app search did not complete')
      }
      // Several Spotlight rows can name one bundle (path aliases, the
      // /System/Volumes/Data view). Identity + realpath collapse those into
      // one candidate; only genuinely distinct apps may count as "more than
      // one", or a single app would look ambiguous.
      const seen = new Map<string, DiscoveredApp>()
      let unresolved = false
      for (const candidate of candidates) {
        // A Spotlight index keeps rows for apps deleted since the last sweep,
        // and a stale row is a *decidable* exclusion: the candidate is gone,
        // which is not the same as "we could not check it". Skipping it here
        // is what stops one dead row from sinking a live app beside it — the
        // plan's "明确不可用 → 排除该候选" case (issue #48 §3.7).
        //
        // Only ENOENT qualifies. `existsSync` is not usable here: it answers
        // `false` for *any* error, so an EACCES/EPERM parent (or an
        // ENAMETOOLONG path) would be read as "this app was deleted" and a
        // live sibling would be chosen over a candidate we merely could not
        // inspect. `statSync` distinguishes them, and anything other than a
        // confirmed absence stays unresolved.
        try {
          statSync(candidate)
        } catch (error: unknown) {
          if (isENOENT(error)) continue
          unresolved = true
          continue
        }
        let bundleIdentifier: string | undefined
        try {
          bundleIdentifier = await this.tools.bundleIdentifier(candidate, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        if (bundleIdentifier === undefined) {
          unresolved = true
          continue
        }
        if (bundleIdentifier !== this.product.macOS.bundleId) continue
        const electronPath = join(candidate, 'Contents', 'MacOS', 'Electron')
        if (!isExecutable(electronPath)) continue
        let identity: string
        try {
          identity = realpathSync(candidate)
        } catch {
          identity = candidate
        }
        if (seen.has(identity)) continue
        let version: string | undefined
        try {
          version = await this.tools.bundleVersion(candidate, controller.signal)
        } catch {
          // Version is display-only; an unreadable one must not sink an
          // otherwise identified candidate.
          version = undefined
        }
        seen.set(identity, { bundlePath: candidate, electronPath, ...version === undefined ? {} : { version } })
      }
      if (seen.size > 1) {
        const listed = [...seen.values()]
          .map(app => `  - ${app.bundlePath}${app.version === undefined ? '' : ` (${app.version})`}`)
          .join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${this.product.envVar} to the one to use`,
        )
      }
      // A candidate nobody could check might have been a second copy, so its
      // existence forbids claiming the rest are unique. This is the difference
      // between "we know there is exactly one" and "we only found one of the
      // ones we could read" (§3.4).
      if (unresolved) throw discoveryIncomplete(this.product.productName, 'some candidates could not be checked')
      if (seen.size === 0) {
        throw new WorkBuddyElectronPathError(
          'electron-binary-not-found',
          `no ${this.product.productName} application was found in the default location or the system index;`
          + ' if it is installed elsewhere, it may not be indexed yet;'
          + ` set ${this.product.envVar} to the app's Electron binary`,
        )
      }
      return [...seen.values()][0]!.electronPath
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  /**
   * Resolve this product's app through Windows uninstall records. Registry
   * entries provide hints, not trust: every DisplayIcon candidate must still
   * be the product's Electron binary with the known Electron layout before
   * execution.
   */
  private async discoverWindowsApp(): Promise<string> {
    if (this.platform !== 'win32') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${this.product.productName} Electron binary is configured for this platform;`
        + ` set ${this.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs)
    try {
      const candidates: string[] = []
      let unresolved = false
      for (const root of WINDOWS_REGISTRY_ROOTS) {
        let output: string
        try {
          output = await this.windowsTools.queryUninstallRoot(root, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        const parsed = parseWindowsRegistryOutput(output, this.product.windows.displayNamePattern)
        candidates.push(...parsed.candidates)
        unresolved ||= parsed.incomplete
      }

      const seen = new Map<string, string>()
      const rejected: string[] = []
      for (const candidate of new Set(candidates)) {
        const inspection = inspectWindowsElectronCandidate(candidate, this.platform, this.product.windows.exeBasename)
        if (inspection === 'unresolved') {
          unresolved = true
          continue
        }
        if (inspection === undefined) {
          rejected.push(candidate)
          continue
        }
        seen.set(inspection.identity, inspection.electronPath)
      }
      if (unresolved) throw discoveryIncomplete(this.product.productName, 'some registry entries or candidates could not be checked')
      if (seen.size > 1) {
        const listed = [...seen.values()].map(path => `  - ${path}`).join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${this.product.envVar} to the one to use`,
        )
      }
      if (seen.size === 0) {
        // #66: "nothing was found" and "candidates were found but each failed
        // the layout check" are different diagnoses; the old single wording
        // claimed the former even when the latter was true, sending users
        // hunting for an install that was right there. The counts stay, the
        // candidate paths deliberately do not — this text reaches /status and
        // doctor, and local install paths are not for every loopback reader.
        const message = rejected.length === 0
          ? `no usable ${this.product.productName} Electron binary was found in the default location or Windows uninstall records;`
            + ` set ${this.product.envVar} to the app's Electron binary`
          : `Windows uninstall records found ${rejected.length} ${this.product.productName} candidate${rejected.length > 1 ? 's' : ''},`
            + ` but ${rejected.length > 1 ? 'none' : 'it'} did not match the expected app layout (the app's exe beside a version file and resources\\app.asar);`
            + ` set ${this.product.envVar} to the installed app's executable to use it`
        throw new WorkBuddyElectronPathError('electron-binary-not-found', message)
      }
      return [...seen.values()][0]!
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  private async spawnPayload(): Promise<string> {
    return await this.spawnHelper(await this.resolveElectronPath())
  }

  private async spawnAt(electronPath: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      execFile(electronPath, [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT], {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }, (error, stdout) => {
        if (error !== null && error !== undefined) {
          // Code and reason only: stdout/stderr can carry paths or crash dumps,
          // and the payload must never appear in a message.
          const reason = error.killed === true
            ? `timed out or was killed after ${String(this.timeoutMs)}ms`
            : error.code !== undefined
              ? `exited with code ${String(error.code)}`
              : 'could not be started'
          reject(new WorkBuddyElectronPathError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) ${reason}`,
          ))
          return
        }
        const output = stdout.trim()
        if (output === '') {
          reject(new WorkBuddyElectronPathError(
            'encrypted-credential-unreadable',
            `the WorkBuddy key helper (${electronPath}) produced no payload`,
          ))
          return
        }
        resolve(output)
      })
    })
  }
}
