/**
 * GLM Coding Plan（zcode）上游客户端——Anthropic Messages 直通，带完整的
 * zcode 客户端线上身份。
 *
 * 权益（150% 加量、plan 额度结算）由服务端按「请求是否形如 zcode 客户端」
 * 裁决，因此请求头分四层（全部从 zcode 3.12.3 逆向取证）：
 * 1. 协议头：`anthropic-version: 2023-06-01` + 鉴权双头（`x-api-key` 与
 *    `Authorization: Bearer` 同值，均为 plan key——zcode 即此形状）；
 * 2. 身份头：`User-Agent: ZCode/<app 版本>`、`X-ZCode-App-Version`、
 *    `HTTP-Referer: https://zcode.z.ai`、`X-Title: Z Code@electron`、
 *    `X-Release-Channel`、`X-Client-Language/Timezone`、`X-ZCode-Agent: glm`、
 *    `X-Platform/X-Os-Category/X-Os-Version`；
 * 3. attribution 头：`x-request-id`/`x-session-id`/`x-query-id`/
 *    `x-zcode-session-type`/`x-zcode-trace-id`，每请求生成 UUID；
 * 4. 客户端签名七件套（{@link ZcodeClientSigning}，凭据为 `id.secret` 形状
 *    时启用），401 `VERIFY_SIGNATURE_*` 时按 zcode 同款自愈链重握手。
 *
 * 请求体与上游错误体零翻译原样中继（协议翻译不属于本层职责）。
 *
 * @module dsh-any-connect/zcode-upstream
 */

import { platform as osPlatform, arch as osArch, release as osRelease } from 'node:os'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { ZcodeCredential } from './zcode-auth.js'
import { ZcodeClientSigning, ZcodeHandshakeError, isSignatureRejection } from './zcode-signing.js'

/** BigModel 的 Anthropic 兼容端点（zcode coding plan 所用的模型面）。 */
export const ZCODE_ANTHROPIC_BASE = 'https://open.bigmodel.cn/api/anthropic'

/** zcode 运行时同款协议版本；SDK 侧发送的同值，这里转发时固定重写。 */
export const ZCODE_ANTHROPIC_VERSION = '2023-06-01'

/** App 版本探测失败时的兜底（与本仓开发期 zcode 稳定版一致）。 */
const FALLBACK_APP_VERSION = '3.12.3'

/** App 版本目录形状（`~/.zcode/v2/runtime/provider/<平台>-<架构>/<版本>/`）。 */
const APP_VERSION_DIR_RE = /^\d+\.\d+\.\d+$/

/** Upstream answer, both shapes kept raw for the shim to relay verbatim. */
export type ZcodeChatResult =
  | { ok: true; status: number; response: Response }
  | {
    ok: false
    status: number
    /** Upstream content-type so the shim can relay the error body verbatim. */
    contentType: string | undefined
    /** Upstream error body (truncated); bigmodel's error shape is its own. */
    body: string
  }

/** Minimal logger surface the shim already defines. */
export interface ZcodeUpstreamLogger {
  warn(...args: unknown[]): void
}

/** Constructor dependencies. */
export interface ZcodeUpstreamOptions {
  /** 客户端签名状态机（直连权益结算的关键）；缺省则全程 unsigned。 */
  signing?: ZcodeClientSigning
  logger?: ZcodeUpstreamLogger
}

/**
 * Best-effort 读取本机 zcode 的 app 版本（身份头的版本取值）：运行时目录里
 * 版本形子目录取最高；读不到回落编译期常量。版本只影响身份头的相似度，
 * 不参与协议正确性。
 */
export async function resolveZcodeAppVersion(): Promise<string> {
  const parent = join(homedir(), '.zcode', 'v2', 'runtime', 'provider', `${osPlatform()}-${osArch()}`)
  try {
    const entries = (await readdir(parent, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && APP_VERSION_DIR_RE.test(entry.name))
      .map(entry => entry.name)
    const newest = entries.sort(compareVersions)[entries.length - 1]
    return newest ?? FALLBACK_APP_VERSION
  } catch {
    return FALLBACK_APP_VERSION
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

let identityCache: Record<string, string> | undefined

/** 进程级共享的 zcode 身份头（同步 getter）：首次调用先给编译期兜底版本，
 * 运行时目录的探测结果回填后，下一次调用起即为真实版本。版本只影响身份头
 * 相似度，不参与协议正确性。 */
export function zcodeIdentity(): Record<string, string> {
  if (identityCache === undefined) {
    identityCache = zcodeIdentityHeaders(FALLBACK_APP_VERSION)
    void resolveZcodeAppVersion().then(version => { identityCache = zcodeIdentityHeaders(version) })
  }
  return identityCache
}

/** 身份头（每进程稳定；语言/时区与 zcode 同源取运行时值）。zcode 家族两个
 * 客户端共用同一份身份。 */
export function zcodeIdentityHeaders(appVersion: string): Record<string, string> {
  const platform = osPlatform() === 'darwin' ? 'macos' : osPlatform()
  let language = 'zh-CN'
  let timezone = 'Asia/Shanghai'
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions()
    language = locale.locale.split('-u-')[0] ?? language
    timezone = locale.timeZone ?? timezone
  } catch {
    // 取不到就保守回落，zcode 缺失时同样是常量兜底。
  }
  return {
    'user-agent': `ZCode/${appVersion}`,
    'x-zcode-app-version': appVersion,
    'http-referer': 'https://zcode.z.ai',
    'x-title': 'Z Code@electron',
    'x-release-channel': 'production',
    'x-client-language': language,
    'x-client-timezone': timezone,
    'x-zcode-agent': 'glm',
    'x-platform': `${platform}-${osArch()}`,
    'x-os-category': platform,
    'x-os-version': osRelease(),
  }
}

/** attribution 头：每请求新 UUID（zcode 语义：会话内共享 session，其余每请求）。 */
function attributionHeaders(sessionId: string): Record<string, string> {
  return {
    'x-request-id': randomUUID(),
    'x-session-id': sessionId,
    'x-zcode-session-type': 'main',
    'x-query-id': randomUUID(),
    'x-zcode-trace-id': randomUUID(),
  }
}

/** Error bodies are diagnostics, not contracts — cap how much is relayed. */
const ERROR_BODY_LIMIT = 4000

export class ZcodeUpstreamClient {
  /** 会话标识：每进程稳定 UUID（签名输入之一；zcode 按会话生成）。 */
  readonly sessionId = randomUUID()

  private readonly signing: ZcodeClientSigning | undefined
  private readonly logger: ZcodeUpstreamLogger | undefined
  private identity: Record<string, string> | undefined

  constructor(options: ZcodeUpstreamOptions = {}) {
    this.signing = options.signing
    this.logger = options.logger
  }

  private async identityOnce(): Promise<Record<string, string>> {
    if (this.identity === undefined) {
      this.identity = zcodeIdentityHeaders(await resolveZcodeAppVersion())
    }
    return this.identity
  }

  /**
   * Forward one Anthropic Messages request verbatim with the full zcode
   * client identity. Streaming and non-streaming answers both come back as
   * the raw upstream `Response`/status/body. Signature self-heal: a 401
   * `VERIFY_SIGNATURE_*` triggers one re-handshake + retry, then permanent
   * unsigned bypass (zcode 同款语义).
   */
  async forwardMessages(
    credential: ZcodeCredential,
    rawBody: string,
    signal: AbortSignal,
  ): Promise<ZcodeChatResult> {
    // 签名状态机随凭据自动同步：手动 key 与跟随 zcode 两种来源共用本客户端。
    this.signing?.setCredential(credential.accessToken)
    const first = await this.send(credential, rawBody, signal)
    if (!first.ok && first.status === 401 && isSignatureRejection(first.body) && this.signing?.supported === true) {
      // 签名校验失败：作废私钥重握手，重试一次；仍拒则本进程永久 unsigned。
      this.signing.markRejected()
      const second = await this.send(credential, rawBody, signal)
      if (!second.ok && second.status === 401 && isSignatureRejection(second.body)) {
        this.signing.markBypassed()
        this.logger?.warn('dsh-any-connect: zcode client signing rejected twice; bypassing signatures for this process')
      }
      return second
    }
    return first
  }

  /** 单次发送；签名握手失败按 fail-open 降级 unsigned（zcode 同款）。 */
  private async send(credential: ZcodeCredential, rawBody: string, signal: AbortSignal): Promise<ZcodeChatResult> {
    let headers: Record<string, string> = {
      ...(await this.identityOnce()),
      ...attributionHeaders(this.sessionId),
      'content-type': 'application/json',
      'anthropic-version': ZCODE_ANTHROPIC_VERSION,
      'x-api-key': credential.accessToken,
      authorization: `Bearer ${credential.accessToken}`,
    }
    if (this.signing?.supported === true) {
      try {
        headers = { ...headers, ...(await this.signing.headers(this.sessionId)) }
      } catch (error: unknown) {
        if (error instanceof ZcodeHandshakeError) {
          // fail-open：握手失败/永久降级 → unsigned 发送，不阻断请求。
          this.logger?.warn(`dsh-any-connect: zcode client signing unavailable (${error.message}); sending unsigned`)
        } else {
          throw error
        }
      }
    }
    const response = await fetch(`${ZCODE_ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal,
    })
    if (response.ok) return { ok: true, status: response.status, response }
    const contentType = response.headers.get('content-type') ?? undefined
    const body = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, contentType, body }
  }
}
