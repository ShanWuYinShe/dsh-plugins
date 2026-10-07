/**
 * auth-desktop-read.ts — 读桌面端 auth 文件（明文 / 5.6 加密信封 / ZCode 文档）。
 *
 * 2026-10-08 从 465 行的 auth-store.ts 拆出：这一族只**读**桌面文件（路径候选由调用方给出），
 * 不碰插件自有副本与刷新策略；抽出来后「桌面文件怎么读」与「token 什么时候刷」分开读。
 *
 * @module dsh-any-connect/auth-desktop-read
 */

import { readFile } from 'node:fs/promises'
import type { WorkBuddyCredential } from './auth-types.js'
import type { WorkBuddyVariant } from './variants.js'
import { parseWorkBuddyAuth, isENOENT } from './auth-document.js'
import { parseZCodeAuth } from './auth-zcode.js'
import {
  classifyDesktopAuthDocument,
  keyIdsOf,
  openAuthField,
  unwrapDesktopAuthDocument,
  WorkBuddyElectronPathError,
  type DesktopAuthClassification,
} from './desktop-credential-protection.js'
import type { WorkBuddyStoreOptions } from './auth-types.js'

/** 读桌面文件所需的上下文（路径候选由类提供，含显式覆盖与平台默认）。 */
export interface DesktopReadContext {
  variant: WorkBuddyVariant
  candidates: () => string[]
  keyProvider: WorkBuddyStoreOptions['keyProvider']
}

  export async function readDesktopCredential(ctx: DesktopReadContext): Promise<WorkBuddyCredential | undefined> {
    for (const desktopPath of ctx.candidates()) {
      let text: string
      try {
        text = await readFile(desktopPath, 'utf8')
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
        continue
      }
      if (ctx.variant.kind === 'zcode') return parseZCodeAuth(text, desktopPath)
      const classification = classifyDesktopAuthDocument(text)
      if (classification.format === 'plaintext') return parseWorkBuddyAuth(text)
      // 空文件(尚未写入/被截断)不构成「凭据在这里」,让下一个候选继续探测。
      if (classification.format === 'absent') continue
      if (classification.format === 'unrecognized') {
        throw new Error(
          `the desktop auth file at ${desktopPath} exists but is unreadable`
          + ' (neither a plaintext credential nor a decodable WorkBuddy 5.6 envelope);'
          + ' fix or remove the file — it outranks the plugin-owned credential copy',
        )
      }
      return await openEncryptedDesktop(ctx, classification)
    }
    return undefined
  }

  /** Open a 5.6 encrypted desktop document into the regular credential shape. */
  async function openEncryptedDesktop(
  ctx: DesktopReadContext,
  classification: Extract<DesktopAuthClassification, { format: 'encrypted' }>,
): Promise<WorkBuddyCredential | undefined> {
    const keyProvider = ctx.keyProvider
    if (keyProvider === undefined) {
      throw new WorkBuddyElectronPathError(
        'encrypted-credential-unreadable',
        'the desktop credential is encrypted but this provider has no at-rest key resolver',
      )
    }
    const key = await keyProvider.protectorKeyFor(keyIdsOf(classification.wrapped.fields))
    const text = unwrapDesktopAuthDocument(classification, field => {
      const plaintext = openAuthField(key, field.envelope)
      if (plaintext === undefined) {
        throw new WorkBuddyElectronPathError(
          'encrypted-credential-unreadable',
          `the encrypted desktop credential's ${field.field} could not be decrypted`
          + ` (envelope key id ${field.envelope.keyId});`
          + ' the WorkBuddy app may hold a different at-rest key — open it once to reseal the sign-in',
        )
      }
      return plaintext
    })
    return parseWorkBuddyAuth(text)
  }
