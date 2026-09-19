/**
 * GLM Coding Plan（zcode）凭据存储。
 *
 * zcode 桌面端把 OAuth token 加密在自家存储里，插件读不出也分享不了；接入
 * 走的是「用户在智谱 bigmodel 控制台创建的 API key」——coding plan 的 key
 * 消耗的是同一份套餐额度，zcode CLI 与本插件只是同一额度的两个消费方。
 *
 * key 的来源优先级（先者胜，空白值视为未配置）：
 *   1. 设置卡的 `apiKeyZcode` 字段；
 *   2. `ZCODE_API_KEY` 环境变量；
 *   3. zcode 客户端凭据库（解密 `~/.zcode/v2/credentials.json` 跟随其登录态，
 *      plan 权益结算的关键来源，见 zcode-credentials.ts）；
 *   4. `$DSH_HOME` 下的插件自有 key 文件。
 * key 不存在过期与刷新周期，store 是静态读取；zcode 重新登录后下一拍自动跟随。
 *
 * @module dsh-any-connect/zcode-auth
 */

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyAuthStatus } from './auth.js'
import { readZcodeClientCredentials } from './zcode-credentials.js'

/** Normalized zcode credential: the API key is the whole credential. */
export interface ZcodeCredential {
  accessToken: string
  /** Which source the key came from; mirrors WorkBuddyCredential.source's role. */
  source: 'config' | 'env' | 'zcode' | 'file'
}

/** Env variable that carries the GLM Coding Plan API key. */
export const ZCODE_API_KEY_ENV = 'ZCODE_API_KEY'

/** Basename of the plugin-owned key file inside the Harness home. */
export const ZCODE_AUTH_FILENAME = '.zcode-auth.json'

/** Current on-disk format of the plugin-owned key file; readers reject others. */
const OWN_FORMAT_VERSION = 1

/** Plugin-owned key file path inside the Harness home. */
export function zcodeOwnAuthPath(filename: string = ZCODE_AUTH_FILENAME): string {
  return join(resolveDshHome(), filename)
}

/** Mask a key for status/doctor display: keep the first and last 4 chars. */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 8) return '••••'
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`
}

/** Trim to a usable key; blank collapses to undefined. */
function normalizeKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === '' ? undefined : trimmed
}

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  apiKey: string
}

async function readOwnKey(path: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    throw new Error(`zcode key file is not valid JSON: ${path}`)
  }
  if (
    document === null || typeof document !== 'object'
    || (document as { version?: unknown }).version !== OWN_FORMAT_VERSION
    || typeof (document as { apiKey?: unknown }).apiKey !== 'string'
  ) {
    throw new Error(`zcode key file has an unrecognized shape: ${path}`)
  }
  return normalizeKey((document as { apiKey: string }).apiKey)
}

/** Constructor options; every field is optional. */
export interface ZcodeCredentialStoreOptions {
  /** The settings card's `apiKeyZcode` value (highest precedence). */
  configuredKey?: string
  /** Explicit plugin-owned key-file path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Explicit zcode credentials-file path for the follow-zcode source
   * (defaults to the real zcode store; tests point it at a dummy path). */
  zcodeCredentialsPath?: string
}

/**
 * Read-only, refresh-free credential store behind the same call surface the
 * WorkBuddy store exposes to its consumers (`current` / `resolve` / `status`
 * / `logout`), plus {@link setConfiguredKey} for settings-card edits.
 *
 * Failure posture: a *missing* key file reads as signed-out (the normal
 * case), but a present-yet-unreadable or malformed file throws — swallowing
 * it would misreport a real misconfiguration as "no key configured" and
 * send the user chasing the wrong fix. {@link status} is the only method
 * that degrades a throw, to a `signed-out` document carrying the reason.
 */
export class ZcodeCredentialStore {
  private configuredKey: string | undefined
  private readonly ownPath: string
  private readonly zcodeCredentialsPath: string | undefined

  constructor(options: ZcodeCredentialStoreOptions = {}) {
    this.configuredKey = normalizeKey(options.configuredKey)
    this.ownPath = options.ownPath ?? zcodeOwnAuthPath()
    this.zcodeCredentialsPath = options.zcodeCredentialsPath
  }

  /** Live-update the settings-card key (blank clears the override). */
  setConfiguredKey(key: string | undefined): void {
    this.configuredKey = normalizeKey(key)
  }

  /** The plugin-owned key file path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** The usable key, or undefined when nothing is configured anywhere.
   * Storage failures other than a missing file propagate. */
  async current(): Promise<ZcodeCredential | undefined> {
    if (this.configuredKey !== undefined) return { accessToken: this.configuredKey, source: 'config' }
    const fromEnv = normalizeKey(process.env[ZCODE_API_KEY_ENV])
    if (fromEnv !== undefined) return { accessToken: fromEnv, source: 'env' }
    // 跟随 zcode 登录态：plan key 由此来源才有权益结算；解密失败向上抛
    // （由 status/refreshCatalog 转成可诊断原因，不吞成「未配置」）。
    const fromZcode = await readZcodeClientCredentials(
      this.zcodeCredentialsPath === undefined ? {} : { path: this.zcodeCredentialsPath },
    )
    if (fromZcode !== undefined) return { accessToken: fromZcode.planApiKey, source: 'zcode' }
    const fromFile = await readOwnKey(this.ownPath)
    return fromFile === undefined ? undefined : { accessToken: fromFile, source: 'file' }
  }

  /** The usable key, or a descriptive error naming every configuration place. */
  async resolve(): Promise<ZcodeCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        `no GLM Coding Plan API key configured; sign in to the zcode desktop app, or set the plugin settings (apiKeyZcode), ${ZCODE_API_KEY_ENV}, or ${this.ownPath}`,
      )
    }
    return credential
  }

  /** Sign-in summary for the status card: the nickname is the masked key.
   * A throwing read degrades to `signed-out` + reason, matching how the
   * WorkBuddy store reports diagnosable absence instead of failing the card. */
  async status(): Promise<WorkBuddyAuthStatus> {
    let credential: ZcodeCredential | undefined
    try {
      credential = await this.current()
    } catch (error: unknown) {
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
    if (credential === undefined) return { state: 'signed-out' }
    return { state: 'signed-in', nickname: maskApiKey(credential.accessToken), source: 'dsh' }
  }

  /** Remove the plugin-owned key file; config- and env-sourced keys survive. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
  }
}
