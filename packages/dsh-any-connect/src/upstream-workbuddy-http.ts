/**
 * upstream-workbuddy-http.ts — WorkBuddy 的基址、请求头、请求体整形与响应信封。
 *
 * 2026-10-08 从 711 行的 upstream-workbuddy.ts 拆出：区域/基址选择、各端点请求头、
 * 请求体规范化（developer→system、tool_choice 归一）与 SSE 首事件/错误码读取。
 *
 * @module dsh-any-connect/upstream-workbuddy-http
 */

import { randomUUID } from 'node:crypto'
import type { WorkBuddyCredential } from './auth.js'
import { classifyUpstreamError, httpStatusLabel, normalizeDeveloperRole, normalizeToolChoice, sanitizeWorkBuddyChannelFingerprints } from './upstream-shared.js'
import { isObject } from './upstream-workbuddy-parse.js'

export type WorkBuddyRegion = 'cn' | 'global'

const CN_CHAT_BASE = 'https://copilot.tencent.com'

const CN_BILLING_BASE = 'https://www.codebuddy.cn'

const GLOBAL_BASE = 'https://www.workbuddy.ai'

export const CLI_VERSION = '2.63.2'

export const CLIENT_UA = `CLI/${CLI_VERSION} CodeBuddy/${CLI_VERSION}`

export function regionOf(domain: string): WorkBuddyRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global'
  return 'cn'
}

/** Chat endpoint base for one credential's region; also identifies which
 * document answered a catalog fetch (the saved-catalog record keeps it so a
 * roster from one endpoint is never served as another's). */
export function chatBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

export function billingBase(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

export function originReferer(credential: WorkBuddyCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

export interface ChatHeaderOptions {
  conversationId?: string
  requestId?: string
}

/**
 * Chat request headers, including official CLI channel-verification headers
 * and X-No-* conventions.
 *
 * The international gateway (workbuddy.ai) enforces strict channel verification:
 * missing X-Conversation-ID, X-Conversation-Request-ID, or X-Conversation-Message-ID
 * fails with HTTP 400 code 11128 ("conversation id missing"). Setting the complete
 * official header set aligns with official CLI behavior across both cn & global gateways.
 */
export function chatHeaders(
  credential: WorkBuddyCredential,
  options?: ChatHeaderOptions,
): Record<string, string> {
  const conversationId = options?.conversationId || randomUUID()
  const requestId = options?.requestId || randomUUID().replace(/-/g, '')
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // 安全红线：chat 请求绝不携带 refresh token。
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
    // 官方客户端渠道校验头：国际网关强校验（缺失即 400/11128 conversation id missing），国内线对齐。
    'X-Conversation-ID': conversationId,
    'X-Session-ID': conversationId,
    'X-Request-ID': requestId,
    'X-Conversation-Request-ID': requestId,
    'X-Conversation-Message-ID': requestId,
    'X-Agent-Type': 'chat',
    'X-Agent-Intent': 'craft',
    'X-IDE-Type': 'cli',
    'X-IDE-Name': 'cli',
    'X-IDE-Version': CLI_VERSION,
  }
  return headers
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
export function refreshHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
export function billingHeaders(credential: WorkBuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
 * force `stream: true` (the upstream rejects non-streaming), flatten
 * `tool_choice` (the upstream's field is a string; object forms return 400),
 * and rewrite `developer` messages as `system`.
 *
 * The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
 * `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
 * upstream rejects that role with HTTP 400 code 11128 ("Illegal API
 * invocation from an unapproved channel"). Rewriting to `system` is the
 * compatible spelling the upstream accepts.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  sanitizeWorkBuddyChannelFingerprints(obj)
  return JSON.stringify(obj)
}

/**
 * The system prompt injected when the international endpoint receives a body
 * with none.
 *
 * Measured requirement, not a guess: the international gateway rejects a body
 * whose first message is not `system` with HTTP 400 code 11128. Minimal on
 * purpose — it exists to satisfy a gateway precondition, not to steer the
 * model — and the normal path never reaches this, since pi-ai already sends
 * the harness's system prompt.
 */
export const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.'

/**
 * Apply the international endpoint's extra chat requirement: the first message
 * must be a system prompt.
 *
 * The added prompt is deliberately empty of user content and prepended, never
 * merged: existing messages keep their order and wording. A body that is not a
 * message list passes through for the upstream to reject.
 */
export function prepareInternationalChatBody(source: string): string {
  const prepared = prepareChatBody(source)
  let body: unknown
  try {
    body = JSON.parse(prepared)
  } catch {
    // Not JSON: nothing to prepend to, and the upstream will reject it anyway.
    return prepared
  }
  if (!isObject(body)) return prepared
  const messages = body['messages']
  if (!Array.isArray(messages)) return prepared
  const first = messages[0]
  if (isObject(first) && first['role'] === 'system') return prepared
  // Unshift, so every caller-supplied message keeps its position and content.
  messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT })
  return JSON.stringify(body)
}

/**
 * Extract conversation ID from chat completions request body if provided by
 * caller (`conversation_id` or `conversationId`).
 */
export function extractConversationId(source: string): string | undefined {
  try {
    const body: unknown = JSON.parse(source)
    if (isObject(body)) {
      const conv = body['conversation_id'] ?? body['conversationId']
      if (typeof conv === 'string' && conv.trim() !== '') {
        return conv.trim()
      }
    }
  } catch {
    // Non-JSON source passes through without an ID.
  }
  return undefined
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

export async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (${httpStatusLabel(response.status)}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddy upstream returned an unexpected document (${httpStatusLabel(response.status)})`)
  }
  const document = parsed as Record<string, unknown>
  const envelope: Envelope = {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
  return envelope
}

/**
 * The canonical token meaning "the upstream rejected this reasoning-effort
 * value". Only the probe keys on it.
 */
const INVALID_EFFORT_CODE = 'invalid_reasoning_effort'

/**
 * Vendor code carrying the same meaning since the 2026-10-11 vocabulary change
 * (top-level `code`, with `extError.code` downgraded to `invalid_request_error`).
 */
const REASONING_EFFORT_REJECTED_CODE = 11150

/**
 * Pull the upstream's error identity out of an error body.
 *
 * The "effort value rejected" answer changed vocabulary: it used to arrive as
 * `extError.code: invalid_reasoning_effort`, and now comes back as
 * `extError.code: invalid_request_error` + top-level `code: 11150` + the
 * message "the reasoning effort value is not supported by the current model".
 * Both are normalized to the canonical {@link INVALID_EFFORT_CODE} here, so
 * the effort probe keys on one vocabulary: a vendor rename must not silently
 * downgrade every probe to `unknown` (measured 2026-10-11: `deepseek-v4.1-flash`
 * rejects `off` exactly this way, and the plugin's own `off` mapping was
 * sending it on every default request).
 */
export function errorCodeOf(text: string): { errorCode?: string; detail?: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const wrapped = parsed as Record<string, unknown>
      const rawExtError = wrapped['extError']
      const extError = typeof rawExtError === 'object' && rawExtError !== null && !Array.isArray(rawExtError)
        ? rawExtError as Record<string, unknown>
        : undefined
      const code = typeof extError?.['code'] === 'string' ? extError['code'] as string : undefined
      if (code === INVALID_EFFORT_CODE) return { errorCode: code, detail: code }
      const message = typeof wrapped['msg'] === 'string' && wrapped['msg'] !== ''
        ? wrapped['msg'] as string
        : typeof extError?.['message'] === 'string' ? extError['message'] as string : ''
      const numericCode = typeof wrapped['code'] === 'number' ? wrapped['code'] : undefined
      if (numericCode === REASONING_EFFORT_REJECTED_CODE || /reasoning effort/i.test(message)) {
        return {
          errorCode: INVALID_EFFORT_CODE,
          detail: message === '' ? code ?? `code ${String(numericCode)}` : message,
        }
      }
      if (code !== undefined) return { errorCode: code, detail: code }
    }
  } catch {
    // Not JSON: fall through to a plain detail line.
  }
  return { detail: text.slice(0, 200) }
}

/**
 * Consume just enough of a streaming response to know it really streams.
 *
 * Returns true on the first chunk containing a data line. Cancels the body
 * afterwards; a stream that ends or errors before that counts as not streamed,
 * because an empty 200 is not evidence the effort was accepted.
 */
export async function readFirstEvent(response: Response): Promise<boolean> {
  const body = response.body
  if (body === null) return false
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      const text = decoder.decode(value, { stream: true })
      if (text.includes('data:')) return true
    }
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
export function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddy upstream ${kind} (${httpStatusLabel(status)}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take
 * the credential explicitly so token refreshes apply on the next call.
 */
