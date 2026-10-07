/**
 * auth-paths.ts — 认证文件路径解析：插件自有副本、桌面端候选路径与 WSL 映射。
 *
 * 2026-10-08 从 1160 行的 auth.ts 拆出：类型、路径解析、ZCode 解析、文档解析与
 * 存储类原本在一个文件里。auth.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/auth-paths
 */

import { homedir, release } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyVariant } from './variants.js'

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/** Plugin-owned copy path inside the Harness home. */
export function workbuddyOwnAuthPath(filename: string = WORKBUDDY_AUTH_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** Directory portion of the desktop auth path, shared by both products. */
const DESKTOP_AUTH_DIR_PARTS = ['CodeBuddyExtension', 'Data', 'Public', 'auth'] as const

const DESKTOP_AUTH_RELATIVE_PATH = [...DESKTOP_AUTH_DIR_PARTS, 'workbuddy-desktop.info'] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
export function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
export function windowsPathForWsl(value: string | undefined): string | undefined {
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

/** Windows ZCode credential candidates visible from a WSL process. */
function wslZCodeDesktopCandidates(home: string, filename: string = 'credentials.json'): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(profile, '.zcode', 'v2', filename),
    join(localAppData, '.zcode', 'v2', filename),
    join(roamingAppData, '.zcode', 'v2', filename),
    join(localAppData, 'zcode', 'v2', filename),
    join(roamingAppData, 'zcode', 'v2', filename),
  ]
}

/**
 * Platform-default candidates for the ZCode desktop app's credentials file, in
 * probe order.
 * - macOS: ~/.zcode/v2/credentials.json, ~/Library/Application Support/(.)zcode/v2/credentials.json
 * - Windows: %USERPROFILE%\.zcode\v2\credentials.json, AppData Local/Roaming roots
 * - WSL: Windows profile & AppData via WSL mount first, then native Linux paths
 * - Linux: ~/.zcode/v2/credentials.json, ~/.config/(.)zcode/v2/credentials.json
 */
export function defaultZCodeDesktopCandidates(filename: string = 'credentials.json'): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [
      join(home, '.zcode', 'v2', filename),
      join(home, 'Library', 'Application Support', 'zcode', 'v2', filename),
      join(home, 'Library', 'Application Support', '.zcode', 'v2', filename),
    ]
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    const roamingAppData = process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return [
      ...new Set([
        join(home, '.zcode', 'v2', filename),
        join(localAppData, '.zcode', 'v2', filename),
        join(roamingAppData, '.zcode', 'v2', filename),
        join(localAppData, 'zcode', 'v2', filename),
        join(roamingAppData, 'zcode', 'v2', filename),
      ]),
    ]
  }
  if (process.platform === 'linux') {
    const linux = [
      join(home, '.zcode', 'v2', filename),
      join(home, '.config', 'zcode', 'v2', filename),
      join(home, '.config', '.zcode', 'v2', filename),
    ]
    return isWsl() ? [...new Set([...wslZCodeDesktopCandidates(home, filename), ...linux])] : linux
  }
  return [join(home, '.zcode', 'v2', filename)]
}

/**
 * Platform-default candidates for one variant, in probe order.
 */
export function desktopAuthCandidatesFor(variant: WorkBuddyVariant): string[] {
  if (variant.kind === 'zcode') {
    return defaultZCodeDesktopCandidates(variant.desktopFilename ?? 'credentials.json')
  }
  return defaultDesktopAuthCandidates().map(path => join(dirname(path), variant.desktopFilename!))
}
