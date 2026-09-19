/**
 * zcode 客户端请求签名（直连 open.bigmodel.cn 必带，feature gate
 * `codingPlanSignature.enable`）。
 *
 * 协议（从 zcode 3.12.3 客户端逆向，全部证据级）：
 *
 * 1. 握手：`POST {origin}/api/paas/c1f3a7e2/v2/client`，头
 *    `Authorization: <apiKeyId.secretKey>`，body
 *    `{apiKey, nonce, sig, ts}`，其中
 *    `sig = base64(HMAC-SHA256(HKDF-SHA256(secret, salt="WD_CLIENT_SIGN_KDF_SALT",
 *    info="getSignKey_hmac"), "get_sign_key\napiKeyId\nts\nnonce"))`。
 *    响应 `data.privateCipher`（base64 的 iv‖tag‖ct）。
 * 2. 解私钥：key = HKDF-SHA256(secret, info="ed25519_priv")，
 *    AES-256-GCM 解密（additionalData = UTF8(apiKeyId)），明文是 base64 的
 *    PKCS8 DER → Ed25519 私钥。
 * 3. 每请求七件 `X-Client-*` 头：Sig = base64(Ed25519 签
 *    `apiKeyId\nts\nclientVersion\nsessionId\nnonce`)；Pow = 双段 SHA-256
 *    找摘要首字节 0x00（prefix = hex(sha256(id\n"zcode"\nsessionId\nts))
 *    前 32 hex，候选 = 24hex 随机 + 8hex 计数器）。
 *
 * 自愈语义与 zcode 一致：握手失败 fail-open（unsigned 发送）；业务 401 且
 * 原因是 `VERIFY_SIGNATURE_INVALID` / `VERIFY_APIKEY_EXPIRED` 时作废私钥
 * 重新握手重试一次，仍被拒则永久 unsigned。
 *
 * @module dsh-any-connect/zcode-signing
 */

import { createHash, createHmac, createPrivateKey, createDecipheriv, hkdfSync, randomBytes, sign as cryptoSign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/** zcode 源码常量：HKDF salt。 */
const KDF_SALT = 'WD_CLIENT_SIGN_KDF_SALT'
/** 握手 HMAC 的 info 与消息首行（action 字符串）。 */
const KDF_INFO_HANDSHAKE = 'getSignKey_hmac'
const KDF_INFO_PRIVATE_KEY = 'ed25519_priv'
/** 握手端点路径（模型面同源）。 */
export const ZCODE_HANDSHAKE_PATH = '/api/paas/c1f3a7e2/v2/client'
/** PoW 的 appId 常量（X-App-Id 同值）。 */
export const ZCODE_APP_ID = 'zcode'
/** PoW 难度（bundle 常量 feo=8）：摘要首字节为 0x00。 */
const POW_BITS = 8

/** 客户端签名凭据：恰好一个 `.` 分隔的 `apiKeyId.secretKey`。 */
export interface ParsedSigningCredential {
  apiKeyId: string
  apiKeySecret: string
}

/** 解析 `id.secret`；形状不符返回 null（手动 key 等走 unsigned）。 */
export function parseClientSigningCredential(credential: string): ParsedSigningCredential | null {
  const dot = credential.indexOf('.')
  if (dot <= 0 || credential.indexOf('.', dot + 1) !== -1) return null
  const apiKeyId = credential.slice(0, dot)
  const apiKeySecret = credential.slice(dot + 1)
  if (apiKeyId.length === 0 || apiKeySecret.length === 0) return null
  return { apiKeyId, apiKeySecret }
}

function hkdf(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, KDF_SALT, info, 32))
}

/** Node 宽容 base64 解码：标准与 url-safe 字母表都接受（对齐 zcode 的 mQt）。 */
function lenientBase64Decode(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

/** 业务 401 是否为签名校验失败（自愈重握手触发条件）。 */
export function isSignatureRejection(body: string): boolean {
  return body.includes('VERIFY_SIGNATURE_INVALID') || body.includes('VERIFY_APIKEY_EXPIRED')
}

/** 握手失败：fail-open 语义（调用方转 unsigned 发送）。 */
export class ZcodeHandshakeError extends Error {
  readonly failOpen = true
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ZcodeHandshakeError'
  }
}

/** 进程内签名状态机：凭据 → 握手 → 每请求签名头。 */
export class ZcodeClientSigning {
  private credential: string | undefined
  private readonly clientVersion: () => string
  private privateKey: KeyObject | undefined
  private bypassed = false
  private handshakeInflight: Promise<void> | undefined

  /** clientVersion 用 getter：app 版本在运行期探测（Info.plist/运行时目录），
   * 签名头取构造时的最新值。 */
  constructor(options: { clientVersion: () => string }) {
    this.clientVersion = options.clientVersion
  }

  /** 更新凭据（凭据变化即作废私钥，下个请求重握手）。 */
  setCredential(credential: string | undefined): void {
    if (credential === this.credential) return
    this.credential = credential
    this.privateKey = undefined
    this.bypassed = false
    this.handshakeInflight = undefined
  }

  /** 当前凭据是否具备签名条件（id.secret 形状且未被永久降级）。 */
  get supported(): boolean {
    return !this.bypassed && parseClientSigningCredential(this.credential ?? '') !== null
  }

  /** 是否已永久降级 unsigned。 */
  get bypass(): boolean {
    return this.bypassed
  }

  /** 401 签名拒绝后调用：作废私钥，下个请求重握手重试。 */
  markRejected(): void {
    this.privateKey = undefined
  }

  /** 重试仍被拒后调用：本进程永久 unsigned（对齐 zcode bypassSigning）。 */
  markBypassed(): void {
    this.bypassed = true
    this.privateKey = undefined
  }

  /** 确保私钥在手（握手单飞；失败抛 ZcodeHandshakeError → fail-open）。 */
  private async ensurePrivateKey(parsed: ParsedSigningCredential): Promise<KeyObject> {
    if (this.privateKey !== undefined) return this.privateKey
    if (this.handshakeInflight === undefined) {
      this.handshakeInflight = this.handshake(parsed)
        .then(key => { this.privateKey = key })
        .finally(() => { this.handshakeInflight = undefined })
    }
    await this.handshakeInflight
    if (this.privateKey === undefined) throw new ZcodeHandshakeError('zcode signing handshake did not yield a private key')
    return this.privateKey
  }

  /** 一次握手：换 privateCipher 并解出 Ed25519 私钥。 */
  private async handshake(parsed: ParsedSigningCredential): Promise<KeyObject> {
    const credential = `${parsed.apiKeyId}.${parsed.apiKeySecret}`
    const ts = Date.now().toString()
    const nonce = randomBytes(16).toString('hex')
    const hmacKey = hkdf(parsed.apiKeySecret, KDF_INFO_HANDSHAKE)
    const sig = createHmac('sha256', hmacKey)
      .update(`get_sign_key\n${parsed.apiKeyId}\n${ts}\n${nonce}`, 'utf8')
      .digest('base64')
    let response: Response
    try {
      response = await fetch(`https://open.bigmodel.cn${ZCODE_HANDSHAKE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: credential,
        },
        body: JSON.stringify({ apiKey: credential, nonce, sig, ts }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error: unknown) {
      throw new ZcodeHandshakeError('zcode signing handshake unreachable', { cause: error })
    }
    const payload = await response.json().catch(() => undefined) as
      | { code?: number; data?: { privateCipher?: unknown }; msg?: string }
      | undefined
    if (!response.ok || payload?.code !== 200 || typeof payload.data?.privateCipher !== 'string') {
      throw new ZcodeHandshakeError(
        `zcode signing handshake rejected (http ${response.status}, code ${String(payload?.code)}, msg ${String(payload?.msg ?? 'n/a').slice(0, 80)})`,
      )
    }
    return decryptSigningPrivateKey(parsed, payload.data.privateCipher)
  }

  /** 单个请求的 X-Client-* 签名头；握手失败抛 ZcodeHandshakeError。 */
  async headers(sessionId: string): Promise<Record<string, string>> {
    if (this.bypassed) throw new ZcodeHandshakeError('zcode client signing is bypassed for this process')
    const parsed = parseClientSigningCredential(this.credential ?? '')
    if (parsed === null) throw new ZcodeHandshakeError('credential is not an id.secret pair')
    const privateKey = await this.ensurePrivateKey(parsed)
    const ts = Date.now().toString()
    const nonce = randomBytes(16).toString('hex')
    // 签名输入五段、\n 分隔（不含 method/URL/body，对齐 zcode）。
    const sig = cryptoSign(null, Buffer.from(`${parsed.apiKeyId}\n${ts}\n${this.clientVersion}\n${sessionId}\n${nonce}`, 'utf8'), privateKey)
    return {
      'x-session-id': sessionId,
      'x-client-ts': ts,
      'x-client-version': this.clientVersion(),
      'x-client-nonce': nonce,
      'x-client-sig': sig.toString('base64'),
      'x-app-id': ZCODE_APP_ID,
      'x-client-pow': solveProofOfWork(parsed.apiKeyId, sessionId, ts),
    }
  }
}

/** 解握手响应的 privateCipher：base64(iv‖tag‖ct)，HKDF 派生 AES 密钥，
 * additionalData = UTF8(apiKeyId)，明文是 base64 的 PKCS8 DER。 */
function decryptSigningPrivateKey(parsed: ParsedSigningCredential, privateCipher: string): KeyObject {
  const blob = lenientBase64Decode(privateCipher)
  if (blob.length <= 12 + 16) {
    throw new ZcodeHandshakeError('zcode signing privateCipher is too short')
  }
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(blob.length - 16)
  const ciphertext = blob.subarray(12, blob.length - 16)
  const key = hkdf(parsed.apiKeySecret, KDF_INFO_PRIVATE_KEY)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  decipher.setAAD(Buffer.from(parsed.apiKeyId, 'utf8'))
  const pkcs8Base64 = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  const der = lenientBase64Decode(pkcs8Base64.trim())
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** 双段 SHA-256 找 8-bit 前导零；X-Client-Pow 的值即候选 nonce 本身。 */
function solveProofOfWork(apiKeyId: string, sessionId: string, ts: string): string {
  const prefix = createHash('sha256').update(`${apiKeyId}\n${ZCODE_APP_ID}\n${sessionId}\n${ts}`, 'utf8').digest('hex').slice(0, 32)
  const random = randomBytes(12).toString('hex')
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    const candidate = `${random}${counter.toString(16).padStart(8, '0')}`
    const digest = createHash('sha256').update(`${prefix}\n${candidate}`, 'utf8').digest()
    if (digest[0] === 0x00) return candidate
  }
  throw new Error('Unable to solve zcode client request proof of work')
}
