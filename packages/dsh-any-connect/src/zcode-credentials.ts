/**
 * 跟随 zcode 客户端凭据：解密本机 zcode 桌面端的凭据存储，取得 coding
 * plan 的 API key（`apiKeyId.secretKey`）与 off-peak 用的 JWT。
 *
 * zcode 的 `~/.zcode/v2/credentials.json` 是自实现 AES-256-GCM 加密（不是
 * Electron safeStorage，也不碰 Keychain）：密文 `enc:v1:` + base64url(iv
 * 12B) + `.` + base64url(tag 16B) + `.` + base64url(ct)，无 AAD；密钥 =
 * SHA-256(credential secret)，secret 优先取环境变量 `ZCODE_CREDENTIAL_SECRET`，
 * 否则是确定性 fallback 串 `zcode-credential-fallback:<platform>:<homedir>:<username>`。
 * 也就是说同用户进程（以本人身份运行）天然可解——本模块正是以用户本人身份
 * 读取本人数据，与 WorkBuddy 变体「跟随桌面 App 登录态」同一产品语义。
 *
 * 只读：绝不写 zcode 的文件；解密结果按文件 mtime 缓存，zcode 重新登录后
 * 下一拍自动跟随。
 *
 * @module dsh-any-connect/zcode-credentials
 */

import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { homedir, platform as osPlatform, userInfo } from 'node:os'
import { join } from 'node:path'
import { stat, readFile, writeFile } from 'node:fs/promises'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** 一次解密得到的 zcode 客户端凭据集。 */
export interface ZcodeClientCredentials {
  /** coding plan 的 API key，`apiKeyId.secretKey` 形状（客户端签名与模型请求共用）。 */
  planApiKey: string
  /** plan key 所属 plan 的账号 id（字段名解析所得，诊断用）。 */
  planAccountId: string
  /** off-peak 通道的 JWT（`zcodejwttoken` 字段）。 */
  jwt: string | undefined
  /** zcode OAuth access token（诊断用；模型请求不直接使用）。 */
  oauthAccessToken: string | undefined
}

/** 环境变量覆盖 zcode 的凭据加密密钥。 */
export const ZCODE_CREDENTIAL_SECRET_ENV = 'ZCODE_CREDENTIAL_SECRET'

const CREDENTIALS_PATH = join(homedir(), '.zcode', 'v2', 'credentials.json')

/** zcode 的 plan key 字段名形状（individual 优先，team 兜底）。 */
const PLAN_KEY_FIELD = /account-provider:coding-plan:account:bigmodel-(individual|team)-coding-plan:account:([^:]+):api-key/

/** 解密用的确定性 fallback secret（zcode 源码常量，按用户/机器参数化）。 */
function fallbackCredentialSecret(): string {
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // userInfo 在极端环境（uid 无对应用户）抛错；zcode 同样回落 unknown。
  }
  return `zcode-credential-fallback:${osPlatform()}:${homedir()}:${username}`
}

function credentialSecret(): string {
  const fromEnv = process.env[ZCODE_CREDENTIAL_SECRET_ENV]
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : fallbackCredentialSecret()
}

function credentialKey(): Buffer {
  return createHash('sha256').update(credentialSecret(), 'utf8').digest()
}

function base64urlDecode(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

/** 解一个 `enc:v1:` 密文；非该前缀的值原样返回 undefined（调用方按需处理明文字段）。 */
function decryptValue(value: string): string | undefined {
  if (!value.startsWith('enc:v1:')) return undefined
  const [ivPart, tagPart, ctPart, ...extra] = value.slice('enc:v1:'.length).split('.')
  if (ivPart === undefined || tagPart === undefined || ctPart === undefined || extra.length > 0) {
    throw new Error('zcode credential ciphertext does not have the enc:v1 iv.tag.ct shape')
  }
  const iv = base64urlDecode(ivPart)
  const tag = base64urlDecode(tagPart)
  const ciphertext = base64urlDecode(ctPart)
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('zcode credential ciphertext has invalid iv/tag lengths')
  }
  const decipher = createDecipheriv('aes-256-gcm', credentialKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/** 文件 path+mtime → 解密结果缓存：zcode 重新登录（文件变化）后自动跟随。 */
let cache: { path: string; mtimeMs: number; size: number; credentials: ZcodeClientCredentials | undefined } | undefined

/**
 * 读取并解密 zcode 的凭据存储。
 *
 * - zcode 未安装 / 未登录（文件不存在）→ undefined，调用方按「未跟随」处理；
 * - 文件存在但解不开（密钥不对、字段损坏）→ 抛错，让调用方把原因带到
 *   状态卡与 doctor——静默吞掉会把真实故障伪装成「未登录」。
 */
export async function readZcodeClientCredentials(options: { path?: string } = {}): Promise<ZcodeClientCredentials | undefined> {
  const path = options.path ?? CREDENTIALS_PATH
  let mtime
  try {
    mtime = await stat(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
  if (cache !== undefined && cache.path === path && cache.mtimeMs === mtime.mtimeMs && cache.size === mtime.size) {
    return cache.credentials
  }
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  if (raw === null || typeof raw !== 'object') {
    throw new Error('zcode credentials file is not a JSON object')
  }
  const decrypted: Record<string, string> = {}
  for (const [field, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !value.startsWith('enc:v1:')) continue
    const plain = decryptValue(value)
    if (plain !== undefined) decrypted[field] = plain
  }
  // individual 优先（用户当前所选），team 兜底可读。
  const planFields = Object.keys(decrypted)
    .map(field => ({ field, match: PLAN_KEY_FIELD.exec(field) }))
    .filter((entry): entry is { field: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => (a.match[1] === 'individual' ? -1 : 1) - (b.match[1] === 'individual' ? -1 : 1))
  const planField = planFields[0]
  const planApiKey = planField?.match === undefined ? undefined : decrypted[planField.field]
  const credentials: ZcodeClientCredentials | undefined = planApiKey === undefined
    ? undefined
    : {
      planApiKey,
      planAccountId: planField!.match[2] ?? '',
      jwt: decrypted['zcodejwttoken'],
      oauthAccessToken: decrypted['oauth:bigmodel:access_token'],
    }
  cache = { path, mtimeMs: mtime.mtimeMs, size: mtime.size, credentials }
  return credentials
}

/** 测试与诊断用：zcode 凭据文件路径。 */
export function zcodeCredentialsPath(): string {
  return CREDENTIALS_PATH
}

/** 诊断用：掩码 plan key（保持 apiKeyId 可读，secret 隐藏）。 */
export function maskPlanApiKey(planApiKey: string): string {
  const dot = planApiKey.indexOf('.')
  if (dot <= 0) return '••••'
  const id = planApiKey.slice(0, dot)
  const visible = id.length > 6 ? `${id.slice(0, 6)}…` : id
  return `${visible}••••`
}

/**
 * 稳定的设备 id（X-Device-Mid 头的取值）：优先跟随 zcode 桌面端注册的
 * `~/.zcode/v2/telemetry-state.json` 的 `deviceMid`——服务端风控核对的是
 * 这个已注册值，自造 id 会被夜间中继判为异常活动。zcode 未安装时才回落
 * 到自生成并持久化到 `$DSH_HOME`。
 */
export async function zcodeDeviceMid(): Promise<string> {
  try {
    const state = JSON.parse(await readFile(join(homedir(), '.zcode', 'v2', 'telemetry-state.json'), 'utf8')) as { deviceMid?: unknown }
    if (typeof state.deviceMid === 'string' && state.deviceMid.trim() !== '') return state.deviceMid
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      // 文件存在但读不了/不是 JSON：按无 deviceMid 处理，走自生成。
    }
  }
  const path = join(resolveDshHome(), '.zcode-device-mid')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing !== '') return existing
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
  const mid = randomUUID()
  await writeFile(path, `${mid}\n`, { encoding: 'utf8', mode: 0o600 })
  return mid
}
