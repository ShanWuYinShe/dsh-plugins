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
): string {
  const suffix = `${variantId} upstream ${kind} (${httpStatusLabel(status)}): ${message.slice(0, 400)}`
  if (status === 403) {
    return `上游拒绝了本次请求（授权未通过 / auth_forbidden，非密钥失效、非内容审核）。`
      + `若同账号在官方客户端也无法对话，属账号权益问题。原文：${suffix}`
  }
  return suffix
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
