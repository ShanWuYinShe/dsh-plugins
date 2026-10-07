/**
 * desktop-discovery-windows.ts — Windows 端 Electron 路径发现（注册表解析）。
 *
 * 2026-10-08 从 desktop-credential-protection.ts（1196 行）拆出：信封密码学、
 * 跨平台发现共享层、Windows 注册表解析与密钥解析器原本混在一个文件里。现在按
 * 「信封 / 发现共享层 / Windows 发现 / 密钥解析器」四分，
 * desktop-credential-protection.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/desktop-discovery-windows
 */

import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS, DiscoveryIncompleteError, isENOENT } from './desktop-discovery.js'

export const WINDOWS_REGISTRY_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
] as const

const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 1024 * 1024

const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u

/** Windows-only seam for querying one uninstall registry root. */
export interface WorkBuddyWindowsDiscoveryTools {
  queryUninstallRoot: (root: string, signal: AbortSignal) => Promise<string>
}

/**
 * The Windows registry discovery tool. It is deliberately separate from the
 * macOS Spotlight/plutil seam: the two platforms have different identity and
 * candidate rules, and neither tool should accidentally become cross-platform.
 */
export function workBuddyWindowsDiscoveryTools(): WorkBuddyWindowsDiscoveryTools {
  const systemRoot = process.env.SystemRoot?.trim()
  const regPath = systemRoot === undefined || systemRoot === ''
    ? undefined
    : join(systemRoot, 'System32', 'reg.exe')
  const runTool = (root: string, signal: AbortSignal): Promise<string> => new Promise<string>((resolve, reject) => {
    if (regPath === undefined) {
      reject(new DiscoveryIncompleteError('SystemRoot is not configured'))
      return
    }
    if (signal.aborted) {
      reject(new DiscoveryIncompleteError('reg.exe was not started: the discovery budget was already spent'))
      return
    }
    let settled = false
    const child = execFile(regPath, ['query', root, '/s'], {
      maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
      timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (settled) return
      settled = true
      // `reg query` uses exit code 1 for more than a missing key. Only a
      // confirmed missing-key diagnostic is an empty result; every other
      // failure stays incomplete rather than becoming "not installed".
      if (error !== null && error !== undefined) {
        if (error.killed !== true && (error.code === 1 || error.code === '1')
          && windowsRegistryKeyMissing(stderr)) {
          resolve('')
          return
        }
        reject(new DiscoveryIncompleteError(`reg.exe could not complete (${error.killed === true ? 'timed out' : String(error.code ?? 'unavailable')})`))
        return
      }
      resolve(stdout)
    })
    const abort = (): void => {
      if (settled) return
      settled = true
      child.kill()
      reject(new DiscoveryIncompleteError('reg.exe was abandoned: the discovery budget was spent'))
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('close', () => { signal.removeEventListener('abort', abort) })
  })
  return { queryUninstallRoot: runTool }
}

/** Only known missing-key diagnostics can safely make a failed query empty. */
function windowsRegistryKeyMissing(stderr: string): boolean {
  const detail = stderr.trim()
  return /^ERROR:\s*The system was unable to find the specified registry key or value\.?$/iu.test(detail)
    || /^错误[:：]\s*系统找不到指定的注册表项或值[。.]?$/u.test(detail)
}

export /**
 * Parse the value columns emitted by `reg query ... /s`.
 *
 * Entries are filtered by the product's DisplayName pattern *before* the
 * DisplayIcon is judged, so another product's records — however broken — are
 * excluded as decisively not ours and can never mark this product's search
 * incomplete.
 */
function parseWindowsRegistryOutput(output: string, displayNamePattern: RegExp): { candidates: string[], incomplete: boolean } {
  const entries = new Map<string, { displayName?: string, displayIcon?: string }>()
  let currentKey: string | undefined
  for (const line of output.split(/\r?\n/u)) {
    const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line)
    if (keyMatch !== null) {
      currentKey = keyMatch[1]!
      entries.set(currentKey, {})
      continue
    }
    if (currentKey === undefined) continue
    const valueMatch = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line)
    if (valueMatch === null) continue
    const entry = entries.get(currentKey)
    if (entry === undefined) continue
    const value = valueMatch[2] ?? ''
    if (valueMatch[1]!.toLowerCase() === 'displayname') entry.displayName = value
    else entry.displayIcon = value
  }
  const candidates: string[] = []
  let incomplete = false
  for (const entry of entries.values()) {
    if (entry.displayName === undefined) continue
    if (!displayNamePattern.test(entry.displayName.trim())) continue
    const displayIcon = entry.displayIcon === undefined ? undefined : parseWindowsDisplayIcon(entry.displayIcon)
    if (displayIcon === undefined) incomplete = true
    else candidates.push(displayIcon)
  }
  return { candidates, incomplete }
}

/** Read a quoted DisplayIcon path and remove the Windows icon-index suffix. */
function parseWindowsDisplayIcon(value: string): string | undefined {
  const raw = value.trim()
  let path: string
  if (raw.startsWith('"')) {
    const closingQuote = raw.indexOf('"', 1)
    if (closingQuote < 0) return undefined
    const suffix = raw.slice(closingQuote + 1).trim()
    if (suffix !== '' && !/^,\d+$/u.test(suffix)) return undefined
    path = raw.slice(1, closingQuote).replace(/,\d+$/u, '')
  } else {
    const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw)
    if (match === null) return undefined
    path = match[1]!
  }
  path = path.trim()
  return /\.exe$/iu.test(path) ? path : undefined
}

interface WindowsCandidateInspection {
  electronPath: string
  identity: string
}

export /**
 * Validate the known Windows layout for the product's exe. `undefined` is a
 * decidable exclusion; `unresolved` is reserved for errors that prevent
 * checking.
 */
function inspectWindowsElectronCandidate(
  electronPath: string,
  platform: NodeJS.Platform,
  exeBasename: string,
): WindowsCandidateInspection | 'unresolved' | undefined {
  if (platform !== 'win32' || basename(electronPath).toLowerCase() !== exeBasename) return undefined
  let binaryStat
  try {
    binaryStat = statSync(electronPath)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!binaryStat.isFile()) return undefined
  try {
    accessSync(electronPath, constants.X_OK)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }

  const installRoot = dirname(electronPath)
  let version: string
  try {
    version = readFileSync(join(installRoot, 'version'), 'utf8').trim()
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return undefined

  try {
    // The archive path must not go through fs.stat: under an Electron host,
    // asar interception stats app.asar as a directory (isFile() false, size
    // 0), which deterministically excluded every registry candidate (#66).
    // Listing the real resources directory is asar-independent — identical
    // on plain Node and inside Electron.
    if (!readdirSync(join(installRoot, 'resources')).includes('app.asar')) return undefined
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }

  let identity: string
  try {
    identity = realpathSync(electronPath)
  } catch (error: unknown) {
    return isENOENT(error) ? undefined : 'unresolved'
  }
  return {
    electronPath,
    // Windows paths are case-insensitive even when a registry entry preserved
    // a different casing from the filesystem spelling.
    identity: platform === 'win32' ? identity.toLowerCase() : identity,
  }
}
