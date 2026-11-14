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
import { parseResetMessage, resolveHeaderResetAt } from './rate-limit.js'

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
  /** 本次请求的模型 id（已知时）：WorkBuddy 的 429 按模型计，文案要说清范围。 */
  model?: string,
): string {
  const suffix = `${variantId} upstream ${kind} (${httpStatusLabel(status)}): ${message.slice(0, 400)}`
  if (status === 429 && kind === 'soft_rate') {
    // 其余上游（WorkBuddy 6004、智谱 1302/1305 等）：恢复时刻可能在响应头，
    // 也可能像 WorkBuddy 一样写在错误体里。两处都没有才说「未提供」。
    const resetAtMs = resolveResetAtMs(headers, message, Date.now())
    const when = resetAtMs === undefined
      ? '上游未提供恢复时间。'
      : `上游表示 ${formatResetAt(resetAtMs)}（本地时间）恢复。`
    // WorkBuddy 的 429 是**按模型**的频率限制（官方文案本身也建议切换其它模型）：
    // 说清只影响这个模型，避免用户把单模型限流误读成整条通道被封、不敢再发请求。
    // 智谱的 1302/1305 是订阅档位并发，不按模型，不能套用这句话。
    const scope = variantId === 'workbuddy' || variantId === 'workbuddy-ai'
      ? (model === undefined || model === '' ? '' : `该限制仅针对模型 ${model}，其它模型仍可继续使用。`)
      : ''
    return `上游限流（${httpStatusLabel(429)}）。${when}${scope}原文：${suffix}`
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
  return resolveHeaderResetAt(headers, nowMs) ?? parseResetMessage(message, nowMs)
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
