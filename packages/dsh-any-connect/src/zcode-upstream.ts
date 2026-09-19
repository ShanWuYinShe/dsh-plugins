/**
 * GLM Coding Plan（zcode）上游客户端——Anthropic Messages 协议直通。
 *
 * zcode 自己就是用标准 Anthropic Messages wire（`x-api-key` +
 * `anthropic-version` + SSE）调用这个端点的，没有私有签名头（签名只出现在
 * 其管理面），认证层也不做客户端门槛（实测无效 key 返回普通 401）。因此
 * 本客户端不做任何协议翻译：shim 把 DSH 侧 pi-ai（anthropic-messages）发来
 * 的请求体原样递过来，这里只补认证头转发。
 *
 * @module dsh-any-connect/zcode-upstream
 */

import type { ZcodeCredential } from './zcode-auth.js'

/** BigModel 的 Anthropic 兼容端点（zcode coding plan 所用的模型面）。 */
export const ZCODE_ANTHROPIC_BASE = 'https://open.bigmodel.cn/api/anthropic'

/** zcode 运行时同款协议版本；SDK 侧发送的同值，这里转发时固定重写。 */
export const ZCODE_ANTHROPIC_VERSION = '2023-06-01'

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

/** Error bodies are diagnostics, not contracts — cap how much is relayed. */
const ERROR_BODY_LIMIT = 4000

export class ZcodeUpstreamClient {
  /**
   * Forward one Anthropic Messages request verbatim, adding only the auth
   * headers. Streaming and non-streaming answers both come back as the raw
   * upstream `Response`/status/body; nothing is classified here — the
   * Anthropic SDK on the DSH side understands its own protocol's errors, and
   * bigmodel's non-standard error JSON relays as-is for the user to read.
   */
  async forwardMessages(
    credential: ZcodeCredential,
    rawBody: string,
    signal: AbortSignal,
  ): Promise<ZcodeChatResult> {
    const response = await fetch(`${ZCODE_ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': credential.accessToken,
        'anthropic-version': ZCODE_ANTHROPIC_VERSION,
      },
      body: rawBody,
      signal,
    })
    if (response.ok) return { ok: true, status: response.status, response }
    const contentType = response.headers.get('content-type') ?? undefined
    const body = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return { ok: false, status: response.status, contentType, body }
  }
}
