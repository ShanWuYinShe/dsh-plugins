/**
 * auth-paths.ts — 认证文件路径解析：插件自有副本、桌面端候选路径与 WSL 映射。
 *
 * 2026-10-08 从 1160 行的 auth.ts 拆出：类型、路径解析、ZCode 解析、文档解析与
 * 存储类原本在一个文件里。auth.ts 退化为 re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/auth-paths
 */

import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { isWsl, windowsPathForWsl } from './wsl.js'
import type { WorkBuddyVariant } from './variants.js'

// WSL 判定与路径转换本体在 ./wsl.ts（desktop-discovery 链路同源共用）；这里
// re-export 维持拆分前的对外 API 不变。
export { isWsl, windowsPathForWsl }

/** Basename of the plugin-owned credential copy inside the Harness home. */
const WORKBUDDY_AUTH_FILENAME = '.workbuddy-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDY_AUTH_FILE_ENV = 'WORKBUDDY_AUTH_FILE'

/**
 * Directory (relative to the Harness home) holding the plugin's own credential
 * copies. 2026-10-11 起自有副本收敛进这个专用子目录（`.dsh-any-connect/`），不再
 * 平铺 `$DSH_HOME` 根——宿主官方包的既有先例是 `dsh-agent-presets` 的
 * `dshHomePath('.agent-presets')` 点前缀子目录。真正的持久化位在状态域
 * （`storages/dsh_any_connect/`，见 state-store.ts）；这里的文件路径只剩
 * 「域不可用时的回落」一个用途。
 */
export const WORKBUDDY_STATE_DIRNAME = '.dsh-any-connect'

/** Plugin-owned copy path inside the Harness home state directory. */
export function workbuddyOwnAuthPath(filename: string = WORKBUDDY_AUTH_FILENAME): string {
  return join(resolveDshHome(), WORKBUDDY_STATE_DIRNAME, filename)
}

/** Directory portion of the desktop auth path, shared by both products. */
const DESKTOP_AUTH_DIR_PARTS = ['CodeBuddyExtension', 'Data', 'Public', 'auth'] as const

const DESKTOP_AUTH_RELATIVE_PATH = [...DESKTOP_AUTH_DIR_PARTS, 'workbuddy-desktop.info'] as const

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

/** Platform-default candidates for OpenCode credentials file. */
export function defaultOpenCodeCandidates(_filename: string = 'auth.json'): string[] {
  const home = homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, '.config')
  const xdgData = process.env.XDG_DATA_HOME || join(home, '.local', 'share')
  return [
    join(xdgConfig, 'opencode', 'auth.json'),
    join(xdgConfig, 'opencode', 'opencode.json'),
    join(xdgData, 'opencode', 'auth.json'),
    join(home, '.opencode', 'auth.json'),
  ]
}

/**
 * Platform-default candidates for one variant, in probe order.
 */
export function desktopAuthCandidatesFor(variant: WorkBuddyVariant): string[] {
  if (variant.kind === 'zcode') {
    return defaultZCodeDesktopCandidates(variant.desktopFilename ?? 'credentials.json')
  }
  if (variant.kind === 'opencode') {
    return defaultOpenCodeCandidates(variant.desktopFilename ?? 'auth.json')
  }
  return defaultDesktopAuthCandidates().map(path => join(dirname(path), variant.desktopFilename!))
}

