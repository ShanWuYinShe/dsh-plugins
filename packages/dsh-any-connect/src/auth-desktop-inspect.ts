/**
 * auth-desktop-inspect.ts — 桌面 auth 文件的诊断检查（路径、格式、helper、是否存在）。
 *
 * 2026-10-08 从 355 行的 auth-store.ts 拆出：这族只**看**不**开**（不 spawn 密钥 helper、
 * 不解密），供 doctor/status 描述「凭据文件长什么样」；与读取凭据、刷新策略分开。
 *
 * @module dsh-any-connect/auth-desktop-inspect
 */

import { readFile } from 'node:fs/promises'
import type { WorkBuddyStoreOptions } from './auth-types.js'
import { classifyDesktopAuthDocument, type DesktopAuthFormat } from './desktop-credential-protection.js'

/** 诊断检查的上下文（路径候选由类提供）。 */
export interface DesktopInspectContext {
  candidates: () => string[]
  keyProvider: WorkBuddyStoreOptions['keyProvider']
}

  export async function resolvedDesktopAuthPath(ctx: DesktopInspectContext): Promise<string | undefined> {
    for (const desktopPath of ctx.candidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch {
        // absent, unreadable, or not a regular file — try the next candidate
        continue
      }
      if (text.trim() === '') continue
      return desktopPath
    }
    return undefined
  }

  /**
   * How the first desktop candidate that carries content is stored:
   * `plaintext`, the 5.6 `encrypted` envelope form, `unrecognized`, or
   * `absent`. Diagnostics only — it never spawns the key helper and never
   * decrypts, so `doctor` can describe the file without opening it.
   */
  export async function desktopAuthFormat(ctx: DesktopInspectContext): Promise<DesktopAuthFormat> {
    for (const desktopPath of ctx.candidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch {
        // absent, unreadable, or not a regular file — try the next candidate
        continue
      }
      const format = classifyDesktopAuthDocument(text).format
      if (format !== 'absent') return format
    }
    return 'absent'
  }

  /**
   * The Electron binary the at-rest key helper would run, for diagnostics;
   * `undefined` when this variant has no helper. Never triggers a discovery
   * search — it reports the path an explicit setting or the platform default
   * already names.
   */
  export function atRestHelperPath(ctx: DesktopInspectContext): string | undefined {
    return ctx.keyProvider?.helperPath()
  }

  /** Whether a desktop-file candidate with content exists; diagnostics only. */
  export async function desktopFilePresent(ctx: DesktopInspectContext): Promise<boolean> {
    return await resolvedDesktopAuthPath(ctx) !== undefined
  }
