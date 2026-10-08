/**
 * desktop-app-discovery.ts — 两个 WorkBuddy 桌面应用的默认安装路径枚举。
 *
 * 只做「平台默认布局」这一层：注册表/Bundle id 的身份判定在
 * desktop-discovery.ts 与 desktop-discovery-windows.ts。海外版的 Windows
 * 默认路径刻意缺失——未实测过的默认值不猜（见 variants.ts 的注释）。
 *
 * @module dsh-any-connect/desktop-app-discovery
 */

import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  WorkBuddyElectronPathError,
  discoveryIncomplete,
  isENOENT,
  isExecutable,
} from './desktop-discovery.js'
import type { DiscoveredApp, WorkBuddyDiscoveryTools } from './desktop-discovery.js'
import {
  WINDOWS_REGISTRY_ROOTS,
  inspectWindowsElectronCandidate,
  parseWindowsRegistryOutput,
} from './desktop-discovery-windows.js'
import type { WorkBuddyWindowsDiscoveryTools } from './desktop-discovery-windows.js'
import type { WorkBuddyElectronProduct } from './variants.js'


/** 发现流程的入参：类把它自己的字段打包传进来。 */
export interface AppDiscoveryContext {
  product: WorkBuddyElectronProduct
  tools: WorkBuddyDiscoveryTools
  windowsTools: WorkBuddyWindowsDiscoveryTools
  platform: NodeJS.Platform
  discoveryBudgetMs: number
}

  /**
   * Resolve this product's app through Spotlight, then prove each candidate's
   * identity before it can be executed.
   *
   * The whole flow shares one budget: a hang in one candidate must not extend
   * the wait for the others, and running out of budget is reported as an
   * unfinished check rather than an absent app.
   */
  export async function discoverMacosApp(ctx: AppDiscoveryContext): Promise<string> {
    if (ctx.platform !== 'darwin') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${ctx.product.productName} Electron binary is configured for this platform;`
        + ` set ${ctx.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ctx.discoveryBudgetMs)
    try {
      let candidates: readonly string[]
      try {
        candidates = await ctx.tools.findApps(controller.signal)
      } catch {
        throw discoveryIncomplete(ctx.product.productName, 'the app search did not complete')
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
          bundleIdentifier = await ctx.tools.bundleIdentifier(candidate, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        if (bundleIdentifier === undefined) {
          unresolved = true
          continue
        }
        if (bundleIdentifier !== ctx.product.macOS.bundleId) continue
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
          version = await ctx.tools.bundleVersion(candidate, controller.signal)
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
          `more than one ${ctx.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${ctx.product.envVar} to the one to use`,
        )
      }
      // A candidate nobody could check might have been a second copy, so its
      // existence forbids claiming the rest are unique. This is the difference
      // between "we know there is exactly one" and "we only found one of the
      // ones we could read" (§3.4).
      if (unresolved) throw discoveryIncomplete(ctx.product.productName, 'some candidates could not be checked')
      if (seen.size === 0) {
        throw new WorkBuddyElectronPathError(
          'electron-binary-not-found',
          `no ${ctx.product.productName} application was found in the default location or the system index;`
          + ' if it is installed elsewhere, it may not be indexed yet;'
          + ` set ${ctx.product.envVar} to the app's Electron binary`,
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
  export async function discoverWindowsApp(ctx: AppDiscoveryContext): Promise<string> {
    if (ctx.platform !== 'win32') {
      throw new WorkBuddyElectronPathError(
        'electron-binary-unavailable',
        `no ${ctx.product.productName} Electron binary is configured for this platform;`
        + ` set ${ctx.product.envVar} to the app's Electron binary`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ctx.discoveryBudgetMs)
    try {
      const candidates: string[] = []
      let unresolved = false
      for (const root of WINDOWS_REGISTRY_ROOTS) {
        let output: string
        try {
          output = await ctx.windowsTools.queryUninstallRoot(root, controller.signal)
        } catch {
          unresolved = true
          continue
        }
        const parsed = parseWindowsRegistryOutput(output, ctx.product.windows.displayNamePattern)
        candidates.push(...parsed.candidates)
        unresolved ||= parsed.incomplete
      }

      const seen = new Map<string, string>()
      const rejected: string[] = []
      for (const candidate of new Set(candidates)) {
        const inspection = inspectWindowsElectronCandidate(candidate, ctx.platform, ctx.product.windows.exeBasename)
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
      if (unresolved) throw discoveryIncomplete(ctx.product.productName, 'some registry entries or candidates could not be checked')
      if (seen.size > 1) {
        const listed = [...seen.values()].map(path => `  - ${path}`).join('\n')
        throw new WorkBuddyElectronPathError(
          'electron-binary-ambiguous',
          `more than one ${ctx.product.productName} application was found, so none was chosen:\n${listed}\n`
          + ` set ${ctx.product.envVar} to the one to use`,
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
          ? `no usable ${ctx.product.productName} Electron binary was found in the default location or Windows uninstall records;`
            + ` set ${ctx.product.envVar} to the app's Electron binary`
          : `Windows uninstall records found ${rejected.length} ${ctx.product.productName} candidate${rejected.length > 1 ? 's' : ''},`
            + ` but ${rejected.length > 1 ? 'none' : 'it'} did not match the expected app layout (the app's exe beside a version file and resources\\app.asar);`
            + ` set ${ctx.product.envVar} to the installed app's executable to use it`
        throw new WorkBuddyElectronPathError('electron-binary-not-found', message)
      }
      return [...seen.values()][0]!
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
