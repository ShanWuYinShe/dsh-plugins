/**
 * shim-http.ts — 回环 shim 的 HTTP 管道：读体（带上限）、写 JSON 与两类错误体。
 *
 * 2026-10-08 从 393 行的 shim.ts 拆出：这些函数只碰 req/res，与 shim 的闭包状态无关，
 * 单独成模块后「协议细节」与「路由分发」分开读。
 *
 * @module dsh-any-connect/shim-http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { UpstreamErrorKind } from './upstream.js'
import { httpStatusLabel } from './upstream-shared.js'
import { parseResetHeader, parseResetMessage } from './rate-limit.js'

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

// 回环守卫统一走 ./loopback.js（本文件此前的局部拷贝已删除：三处分化后
// shim 版与标准版在 `[::1]garbage` 上语义不一致，单源是唯一的修法）。
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
export function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
export const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  // auth_forbidden 刻意映射 400 而非 403：返回 401/403 会让宿主（pi-ai / deepseek
  // 两处都按状态码判 AUTH）把它重新显示成「API 密钥无效」，覆盖掉我们写好的
  // 如实文案——这正是 2026-10-08 排障修掉的那个误报。语义区分靠 kind 本身。
  auth_forbidden: 400,
  not_found: 502,
  server: 502,
  client: 400,
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * 失败文案的单一构造点。
 *
 * 两件事必须同时做到，缺一个用户就看不懂：
 * 1. **状态码不能裸写**（见 upstream-shared.httpStatusLabel）：宿主用正则
 *    `/\b(?:401|403)\b/` 分类，命中即判 AUTH 并丢弃我们的文案。
 * 2. **要覆盖上游的误导性文案**：海外网关对 403 回的 `displayMsg` 写的是
 *    "内容未通过安全审核"，但官方客户端的错误码表里 11140 =
 *    auth/subcategory=auth_forbidden（与内容无关、与密钥也无关）。原样透传会让用户
 *    去改 prompt，或者像本次一样被告知"API 密钥无效"。
 *
 * 因此 403 一律前置一句如实说明，再把上游原文附在后面（保留可诊断性）。
 */
export function upstreamFailureMessage(
  variantId: string,
  kind: string,
  status: number,
  message: string,
  headers?: { get(name: string): string | null },
): string {
  const suffix = `${variantId} upstream ${kind} (${httpStatusLabel(status)}): ${message.slice(0, 400)}`
  const lower = message.toLowerCase()
  const isOpenCodeVariant = variantId.includes('opencode')
  // 上游的两种拒绝必须分开说：FreeUsageLimitError 是免费额度用完（有额度窗口），
  // FreeTierError 是网关只认官方客户端形状（与额度无关）。旧文案把两者连同
  // 传输错误都套成「频次限流」，用户只会反复重试一个根本不会恢复的请求。
  const isFreeQuota = message.includes('FreeUsageLimitError')
  const isFreeTierGate = message.includes('FreeTierError')
    || lower.includes('free tier can only be used from within opencode')
  const resetHint = formatResetHint(headers, message)
  if (isOpenCodeVariant && isFreeQuota) {
    return `OpenCode 免费模型额度已用尽（上游 FreeUsageLimitError）：该额度按账号/IP 计算，不是 API 密钥失效，也不是短时并发限流。`
      + `${resetHint}可改用 OpenCode Go 订阅（https://opencode.ai/go）、在 DSH 中切换其他模型，或等免费额度重置后再试。原文：${suffix}`
  }
  if (isFreeTierGate) {
    return `OpenCode 官方网关拒绝了本次免费模型请求（FreeTierError）：该网关只接受官方客户端形状的请求，与额度、密钥均无关。`
      + `插件已注入 read 工具守卫；若持续出现，请检查请求是否被代理或网关改写。原文：${suffix}`
  }
  if (isOpenCodeVariant && status === 429 && kind === 'soft_rate') {
    return `OpenCode 官方免费通道触发了上游限流（HTTP 429）：免费模型对并发与调用频次有严格限制。`
      + `${resetHint}请稍后重试，或切换到其他可用免费模型（如 big-pickle 等）。原文：${suffix}`
  }
  if (status === 429 && kind === 'soft_rate') {
    // 其余上游（WorkBuddy 6004、智谱 1302/1305 等）：恢复时刻可能在响应头，
    // 也可能像 WorkBuddy 一样写在错误体里。两处都没有才说「未提供」。
    const resetAtMs = resolveResetAtMs(headers, message, Date.now())
    const when = resetAtMs === undefined
      ? '上游未提供恢复时间。'
      : `上游表示 ${formatResetAt(resetAtMs)}（本地时间）恢复。`
    return `上游限流（${httpStatusLabel(429)}）。${when}原文：${suffix}`
  }
  if (status === 403) {
    return `上游拒绝了本次请求（授权未通过 / auth_forbidden，非密钥失效、非内容审核）。`
      + `若同账号在官方客户端也无法对话，属账号权益问题。原文：${suffix}`
  }
  return suffix
}

/** 恢复时刻的两个来源：响应头优先，其次是错误体里明写的带时区时刻。 */
function resolveResetAtMs(
  headers: { get(name: string): string | null } | undefined,
  message: string,
  nowMs: number,
): number | undefined {
  return parseResetHeader(headers?.get('retry-after'), nowMs)
    ?? parseResetHeader(headers?.get('x-ratelimit-reset'), nowMs)
    ?? parseResetMessage(message, nowMs)
}

/** 把恢复时刻写成人话；没有就明说「没给」，不推算。 */
function formatResetHint(
  headers?: { get(name: string): string | null },
  message?: string,
): string {
  const resetAtMs = resolveResetAtMs(headers, message ?? '', Date.now())
  if (resetAtMs === undefined) return '本次响应未给出恢复时间，请稍后再试。'
  return `上游给出的恢复时间为 ${formatResetAt(resetAtMs)}（本地时间）。`
}

/** 本地时区的 `YYYY-MM-DD HH:mm`，只用于错误文案。 */
function formatResetAt(atMs: number): string {
  const at = new Date(atMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

export function writeAnthropicError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { type: 'error', error: { type: kind, message } })
}

/** 请求体超限的专属标记:兜底 catch 据此映射 413,而非落进 500 internal。 */
export class RequestBodyTooLarge extends Error {
  constructor() { super('request body too large') }
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new RequestBodyTooLarge())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
