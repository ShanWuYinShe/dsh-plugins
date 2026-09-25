/**
 * ZCode client request signing V4: cryptographic handshake, Proof of Work (PoW),
 * and Ed25519 per-request signing.
 *
 * BigModel verifies these headers to confirm requests originate from the
 * genuine ZCode desktop client, granting Coding Plan 150% quota and nighttime
 * (23:00-09:00) free Flash usage.
 *
 * @module dsh-any-connect/zcode-signer
 */

import crypto from 'node:crypto'
import os from 'node:os'
import { withTimeout } from './timeout.js'

const KDF_SALT = 'WD_CLIENT_SIGN_KDF_SALT'
const INFO_HMAC = 'getSignKey_hmac'
const INFO_PRIV = 'ed25519_priv'
const APP_ID = 'zcode'
const CLIENT_VERSION = '3.4.0'
const DEFAULT_HANDSHAKE_URL = 'https://open.bigmodel.cn/api/paas/c1f3a7e2/v2/client'
/** 握手超时:与其余上游端点的「响应头 30s」口径一致。 */
const HANDSHAKE_TIMEOUT_MS = 30_000

export interface ZCodeParsedKey {
  apiKeyId: string
  apiKeySecret: string
  credential: string
}

export function parseZCodeApiKey(raw: string): ZCodeParsedKey | undefined {
  const trimmed = raw.trim()
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot !== trimmed.lastIndexOf('.') || !trimmed.slice(0, dot).trim() || !trimmed.slice(dot + 1).trim()) {
    return undefined
  }
  return {
    apiKeyId: trimmed.slice(0, dot),
    apiKeySecret: trimmed.slice(dot + 1),
    credential: trimmed,
  }
}

/** Solves a Proof-of-Work puzzle requiring `powBits` leading zero bits in SHA-256. */
export function solveClientRequestProofOfWork(options: {
  apiKeyId: string
  appId?: string
  sessionId: string
  ts: string
  powBits?: number
}): string {
  const appId = options.appId ?? APP_ID
  const powBits = options.powBits ?? 8
  const prefixInput = `${options.apiKeyId}\n${appId}\n${options.sessionId}\n${options.ts}`
  const hash = crypto.createHash('sha256').update(prefixInput).digest('hex').slice(0, 32)
  const nonce = crypto.randomBytes(12).toString('hex')

  const fullBytes = Math.floor(powBits / 8)
  const remBits = powBits % 8
  const remMask = remBits === 0 ? 0 : (0xff << (8 - remBits)) & 0xff

  for (let s = 0; s <= 0xffffffff; s += 1) {
    const candidate = `${nonce}${s.toString(16).padStart(8, '0')}`
    const digest = crypto.createHash('sha256').update(`${hash}\n${candidate}`).digest()

    let matched = true
    for (let i = 0; i < fullBytes; i += 1) {
      if (digest[i] !== 0) {
        matched = false
        break
      }
    }
    if (matched && (remBits === 0 || ((digest[fullBytes] ?? 0xff) & remMask) === 0)) {
      return candidate
    }
  }
  throw new Error('Unable to solve client request proof of work')
}

export class ZCodeClientSigner {
  private readonly handshakeUrl: string
  private readonly handshakeTimeoutMs: number
  private readonly keyState = new Map<string, Buffer>()
  private readonly handshakePromises = new Map<string, Promise<Buffer>>()

  constructor(options?: { handshakeUrl?: string; handshakeTimeoutMs?: number }) {
    this.handshakeUrl = options?.handshakeUrl ?? DEFAULT_HANDSHAKE_URL
    this.handshakeTimeoutMs = options?.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  }

  async ensurePrivateKey(apiKey: string): Promise<Buffer> {
    const parsed = parseZCodeApiKey(apiKey)
    if (!parsed) {
      throw new Error('Invalid ZCode API key format (expected apiKeyId.apiKeySecret)')
    }

    const cached = this.keyState.get(apiKey)
    if (cached) return cached

    const existingPromise = this.handshakePromises.get(apiKey)
    if (existingPromise) return existingPromise

    const promise = this.performHandshake(parsed)
      .then(keyDer => {
        this.keyState.set(apiKey, keyDer)
        return keyDer
      })
      .finally(() => {
        this.handshakePromises.delete(apiKey)
      })

    this.handshakePromises.set(apiKey, promise)
    return promise
  }

  private async performHandshake(parsed: ZCodeParsedKey): Promise<Buffer> {
    const ts = String(Date.now())
    const nonce = crypto.randomBytes(16).toString('hex')

    // HKDF derive HMAC key
    const hmacKeyRaw = crypto.hkdfSync('sha256', parsed.apiKeySecret, KDF_SALT, INFO_HMAC, 32)
    const hmac = crypto.createHmac('sha256', Buffer.from(hmacKeyRaw))
    hmac.update(`get_sign_key\n${parsed.apiKeyId}\n${ts}\n${nonce}`)
    const sig = hmac.digest('base64')

    // 握手结果有缓存,但首个请求仍要过网络:这里若不设超时,握手端点挂死
    // 时整个 chatStream 挂到 undici 默认 headersTimeout(约 300s),调用方
    // 的 signal 与 30s 头超时口径全部失效——签名器自己兜住,不依赖调用方
    // 把 signal 层层传进来。
    const res = await withTimeout(undefined, this.handshakeTimeoutMs, 'ANY_CONNECT_HANDSHAKE', async (signal) =>
      fetch(this.handshakeUrl, {
        method: 'POST',
        headers: {
          'Authorization': parsed.credential,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: parsed.credential,
          nonce,
          sig,
          ts,
        }),
        signal,
      }),
    )

    if (!res.ok) {
      throw new Error(`ZCode signing handshake HTTP failed: ${res.status}`)
    }

    const json = (await res.json()) as { code?: number; msg?: string; data?: { privateCipher?: string } }
    if (json.code !== 200 || !json.data?.privateCipher) {
      throw new Error(`ZCode signing handshake rejected: code=${json.code} msg=${json.msg ?? 'unknown'}`)
    }

    const cipherBytes = Buffer.from(json.data.privateCipher, 'base64')
    if (cipherBytes.length <= 28) {
      throw new Error('ZCode privateCipher is too short')
    }

    // HKDF derive AES-GCM key
    const aesKeyRaw = crypto.hkdfSync('sha256', parsed.apiKeySecret, KDF_SALT, INFO_PRIV, 32)
    const iv = cipherBytes.subarray(0, 12)
    const ciphertextWithTag = cipherBytes.subarray(12)
    const ciphertext = ciphertextWithTag.subarray(0, -16)
    const tag = ciphertextWithTag.subarray(-16)

    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKeyRaw), iv)
    decipher.setAuthTag(tag)
    decipher.setAAD(Buffer.from(parsed.apiKeyId, 'utf8'))
    const pkcs8B64 = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')

    return Buffer.from(pkcs8B64, 'base64')
  }

  async buildHeaders(options: {
    apiKey: string
    sessionId?: string
    clientVersion?: string
  }): Promise<Record<string, string>> {
    const parsed = parseZCodeApiKey(options.apiKey)
    if (!parsed) {
      throw new Error('Invalid ZCode API key format (expected apiKeyId.apiKeySecret)')
    }

    const privateKeyDer = await this.ensurePrivateKey(options.apiKey)
    const sessionId = options.sessionId ?? crypto.randomUUID()
    const clientVersion = options.clientVersion ?? CLIENT_VERSION
    const ts = String(Date.now())
    const clientNonce = crypto.randomBytes(16).toString('hex')
    const pow = solveClientRequestProofOfWork({ apiKeyId: parsed.apiKeyId, sessionId, ts })

    const signData = `${parsed.apiKeyId}\n${ts}\n${clientVersion}\n${sessionId}\n${clientNonce}`
    const privKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' })
    const clientSig = crypto.sign(null, Buffer.from(signData, 'utf8'), privKey).toString('base64')

    const osPlatform = os.platform()
    const osCategory = osPlatform === 'darwin' ? 'macos' : osPlatform === 'win32' ? 'windows' : 'linux'

    return {
      'Authorization': `Bearer ${parsed.credential}`,
      'User-Agent': `ZCode/${clientVersion}`,
      'X-App-Id': APP_ID,
      'X-Client-Version': clientVersion,
      'X-ZCode-App-Version': clientVersion,
      'X-Session-Id': sessionId,
      'X-Client-Ts': ts,
      'X-Client-Nonce': clientNonce,
      'X-Client-Pow': pow,
      'X-Client-Sig': clientSig,
      'X-Title': 'Z Code@cli',
      'X-Release-Channel': 'stable',
      'X-ZCode-Agent': 'glm',
      'X-Platform': `${osPlatform}-${os.arch()}`,
      'X-Os-Category': osCategory,
    }
  }
}
