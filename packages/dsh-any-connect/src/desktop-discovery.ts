/**
 * desktop-discovery.ts — 桌面端发现共享层：路径发现工具、平台判定与错误分类。
 *
 * 2026-10-08 从 desktop-credential-protection.ts（1196 行）拆出：信封密码学、
 * 跨平台发现共享层、Windows 注册表解析与密钥解析器原本混在一个文件里。现在按
 * 「信封 / 发现共享层 / Windows 发现 / 密钥解析器」四分，
 * desktop-credential-protection.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/desktop-discovery
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { WorkBuddyElectronProduct } from './variants.js'
import type { WorkBuddySignedOutReasonCode } from './desktop-auth-envelope.js'

/**
 * Env variable naming an explicit Electron binary for the CN product. The
 * international product has its own ({@link WorkBuddyElectronProduct.envVar}
 * on each variant); a shared variable is a single point of failure across two
 * independently installed apps (issue #60).
 */
export const WORKBUDDY_ELECTRON_BIN_ENV = 'WORKBUDDY_ELECTRON_BIN'

/**
 * The platform-default Electron binary for one product, or `undefined` where
 * none is verified. macOS defaults come from each product's measured layout;
 * the Windows default needs `LOCALAPPDATA`, and the international app has no
 * verified default location at all — registry discovery only, never a guess.
 */
export function defaultWorkBuddyElectronPath(
  product: WorkBuddyElectronProduct,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'darwin') return product.macOS.defaultPath
  if (platform !== 'win32' || product.windows.defaultPathSegments === undefined) return undefined
  const localAppData = process.env.LOCALAPPDATA?.trim()
  return localAppData === undefined || localAppData === ''
    ? undefined
    : join(localAppData, ...product.windows.defaultPathSegments)
}

/** A resolved protector key and the id envelopes name for it. */
export interface ResolvedKey {
  key: Buffer
  keyId: string
}

/**
 * Which automatic discovery, if any, this provider may run when no explicit
 * binary is configured.
 *
 * The value says which *platform* may be searched, never which product: two
 * products on the same platform are told apart by the product profile
 * ({@link WorkBuddyElectronProduct} — bundle id, registry name, exe basename),
 * so a search for one can never execute the other's binary. `none` remains the
 * safe default for platforms without a verified layout (Linux today).
 */
export type WorkBuddyElectronDiscovery = 'none' | 'macos-workbuddy' | 'windows-workbuddy'

/**
 * Select discovery by platform. Both products have verified layouts on macOS
 * and Windows (the international app is registry-only there), so discovery no
 * longer gates on region; Linux and others stay `none`.
 */
export function electronDiscoveryFor(
  platform: NodeJS.Platform = process.platform,
): WorkBuddyElectronDiscovery {
  if (platform === 'darwin') return 'macos-workbuddy'
  if (platform === 'win32') return 'windows-workbuddy'
  return 'none'
}

/** Absolute tool paths: never resolved through PATH, which a user can change. */
const MDFIND_BIN = '/usr/bin/mdfind'

const PLUTIL_BIN = '/usr/bin/plutil'

/** One discovery subprocess's own limits; see {@link WorkBuddyAtRestKeyProviderOptions}. */
export const WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS = 3_000

/** Whole-discovery budget, independent of the helper's own timeout. */
export const WORKBUDDY_DISCOVERY_BUDGET_MS = 10_000

const MDFIND_MAX_OUTPUT_BYTES = 1024 * 1024

const PLUTIL_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Why a discovery step could not produce an answer. Every one of these means
 * "we do not know", explicitly *not* "the candidate does not exist" — the
 * distinction is what keeps a half-finished check from being mistaken for a
 * unique candidate.
 */
export class DiscoveryIncompleteError extends Error {}

/** A discovered app: its `.app` bundle and the Electron binary inside it. */
export interface DiscoveredApp {
  bundlePath: string
  electronPath: string
  /** Display version, best effort; absent when unreadable. */
  version?: string
}

/** Seams the discovery flow runs through, so tests never spawn a process. */
export interface WorkBuddyDiscoveryTools {
  /** Candidate `.app` bundles for the product's bundle id, or a throw for an unusable tool. */
  findApps: (signal: AbortSignal) => Promise<readonly string[]>
  /**
   * `CFBundleIdentifier` of a bundle, or `undefined` when the tool could not
   * read it — which is "we could not check this candidate", never "it does not
   * match". A successful read of a *different* id returns that id, and the
   * caller excludes the candidate.
   */
  bundleIdentifier: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
  /** Display version, best effort; `undefined` when unavailable. */
  bundleVersion: (bundlePath: string, signal: AbortSignal) => Promise<string | undefined>
}

/**
 * The default discovery tools: Spotlight for the bundle, `/usr/bin/plutil` for
 * identity. Every failure that means "we could not tell" — a missing tool, a
 * timeout, an oversized answer — is raised as {@link DiscoveryIncompleteError}
 * so it can never be silently read as "no such app".
 *
 * `bundleId` is the product being searched for; the Spotlight query and the
 * caller's identity comparison both use it, so the two can never disagree
 * about which app they are looking for.
 */
export function workBuddyDiscoveryTools(bundleId: string): WorkBuddyDiscoveryTools {
  const runTool = (bin: string, args: readonly string[], maxBytes: number, signal: AbortSignal): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DiscoveryIncompleteError(`${bin} was not started: the discovery budget was already spent`))
        return
      }
      let settled = false
      const child = execFile(bin, [...args], { maxBuffer: maxBytes, timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS }, (error, stdout) => {
        if (settled) return
        settled = true
        if (error !== null && error !== undefined) {
          reject(new DiscoveryIncompleteError(`${bin} could not complete (${error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')})`))
          return
        }
        resolve(stdout)
      })
      const abort = (): void => {
        if (settled) return
        settled = true
        child.kill()
        reject(new DiscoveryIncompleteError(`${bin} was abandoned: the discovery budget was spent`))
      }
      signal.addEventListener('abort', abort, { once: true })
      child.on('close', () => { signal.removeEventListener('abort', abort) })
    })

  return {
    findApps: async signal => {
      const out = await runTool(
        MDFIND_BIN,
        [`kMDItemCFBundleIdentifier == '${bundleId}'`],
        MDFIND_MAX_OUTPUT_BYTES,
        signal,
      )
      return out.split('\n').map(line => line.trim()).filter(line => line.endsWith('.app'))
    },
    bundleIdentifier: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        return out.trim()
      } catch {
        // An unreadable plist is "we could not check this one", not "this one
        // does not match" — the candidate stays unresolved and the whole
        // discovery reports incomplete rather than quietly dropping it.
        return undefined
      }
    },
    bundleVersion: async (bundlePath, signal) => {
      try {
        const out = await runTool(
          PLUTIL_BIN,
          ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')],
          PLUTIL_MAX_OUTPUT_BYTES,
          signal,
        )
        const version = out.trim()
        return version === '' ? undefined : version
      } catch {
        return undefined
      }
    },
  }
}

/** Whether a path exists and is executable; never throws. */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A failure the card must be able to classify. The code travels with the error
 * so the store can promote it to `reasonCode` without re-deriving the cause
 * from prose.
 */
export class WorkBuddyElectronPathError extends Error {
  readonly reasonCode: WorkBuddySignedOutReasonCode

  constructor(reasonCode: WorkBuddySignedOutReasonCode, message: string) {
    super(message)
    this.name = 'WorkBuddyElectronPathError'
    this.reasonCode = reasonCode
  }
}

/** Read the reason code off an arbitrary thrown value, when it carries one. */
export function reasonCodeOf(error: unknown): WorkBuddySignedOutReasonCode | undefined {
  return error instanceof WorkBuddyElectronPathError ? error.reasonCode : undefined
}

/** Whether a filesystem error reports an absent path (`existsSync` cannot tell). */
export function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

export function discoveryIncomplete(productName: string, detail: string): WorkBuddyElectronPathError {
  return new WorkBuddyElectronPathError(
    'electron-discovery-incomplete',
    `the ${productName} application search did not finish (${detail});`
    + ' this is not proof that the app is missing',
  )
}

/**
 * The helper: run inside WorkBuddy's Electron as plain Node, where the
 * private `workbuddyStorage` binding exists, and print only the payload. It
 * writes nothing else, so whatever reaches stdout is the payload.
 */
export const HELPER_SCRIPT = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

export const HELPER_SCRIPT_ARGUMENT_FLAG = '-e'
