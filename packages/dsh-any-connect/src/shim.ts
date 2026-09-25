/**
 * Loopback endpoint. The pi-ai provider points here: an OpenAI-compatible
 * route whose handler applies the WorkBuddy wire quirks (forced streaming,
 * string `tool_choice`, CLI-shaped headers). All of it binds 127.0.0.1 only
 * and never serves another interface.
 *
 * Inbound hardening: the loopback bind alone is not a trust boundary (any
 * local process or a DNS-rebinding page can reach 127.0.0.1), so every
 * request must carry a loopback Host header, browser-sent Origins must be
 * loopback, POSTs must be application/json, and the request must carry the
 * shim's per-process shared secret as `Authorization: Bearer`. The plugin's
 * own client satisfies these by construction; local attackers cannot read
 * the secret out of the plugin process's memory.
 *
 * @module dsh-any-connect/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { WorkBuddyCredentialStore } from './auth.js'
import type { WorkBuddyCatalog } from './catalog.js'
import { hostIsLoopback, originIsLoopback } from './loopback.js'
import { prepareChatBody, WorkBuddyUpstreamClient, type UpstreamErrorKind } from './upstream.js'

/** Minimal logger surface the plugin context already provides. */
export interface ShimLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** What the plugin needs from a running shim. */
export interface WorkBuddyShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter
   * resolves this instead of the upstream access token, because the shim
   * resolves the real credential itself via the store.
   */
  token(): string
  /** Stop serving and destroy open connections. */
  close(): Promise<void>
}

/** Constructor dependencies. */
export interface WorkBuddyShimOptions {
  kind: 'workbuddy' | 'zcode'
  store: Pick<WorkBuddyCredentialStore, 'resolve'>
  client: Pick<WorkBuddyUpstreamClient, 'chatStream'>
  catalog: WorkBuddyCatalog
  logger?: ShimLogger
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

// 回环守卫统一走 ./loopback.js（本文件此前的局部拷贝已删除：三处分化后
// shim 版与标准版在 `[::1]garbage` 上语义不一致，单源是唯一的修法）。
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS: Readonly<Record<UpstreamErrorKind, number>> = {
  hard_credit: 402,
  soft_rate: 429,
  session_dead: 401,
  not_found: 502,
  server: 502,
  client: 400,
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

function writeAnthropicError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { type: 'error', error: { type: kind, message } })
}

/** 请求体超限的专属标记:兜底 catch 据此映射 413,而非落进 500 internal。 */
class RequestBodyTooLarge extends Error {
  constructor() { super('request body too large') }
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req: IncomingMessage): Promise<Buffer> {
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

/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
export function createWorkBuddyShim(options: WorkBuddyShimOptions): WorkBuddyShim {
  const logger = options.logger
  const catalog = options.catalog
  const store = options.store
  const client = options.client

  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the client apiKey — the OpenAI SDK sends it as `Authorization: Bearer
  // ...`. The shim never forwards it upstream — the real credential comes
  // from the store. A local attacker who can hit the port still cannot forge
  // this.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time check of one presented secret against the shared secret. */
  function secretOk(presented: string): boolean {
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /** Bearer or x-api-key check (OpenAI and Anthropic headers). */
  function secretFromRequest(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization
    if (typeof header === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim())
      if (match !== null) return match[1]
    }
    const xApiKey = req.headers['x-api-key']
    if (typeof xApiKey === 'string' && xApiKey.trim() !== '') {
      return xApiKey.trim()
    }
    return undefined
  }

  function authOk(req: IncomingMessage): boolean {
    const secret = secretFromRequest(req)
    if (secret === undefined) return false
    return secretOk(secret)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  server.listen(0, '127.0.0.1')

  const baseUrl = (): string => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('workbuddy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  /** Kind-shaped auth failure so the calling SDK can parse the rejection. */
  function writeUnauthorized(res: ServerResponse): void {
    writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // Inbound hardening: every request must name the loopback host, and
      // browser-sent origins must be loopback too. The plugin's own client
      // always satisfies both; DNS-rebinding pages and cross-origin POSTs
      // do not.
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      const url = req.url ?? '/'
      // 按 pathname 匹配：SDK 会带查询串（如 ?beta=true），全等
      // 匹配会把合法请求打成 404。鉴权失败的错误体形状也依赖它,故
      // 提前到鉴权之前计算。
      const pathname = new URL(url, 'http://127.0.0.1').pathname
      if (!authOk(req)) {
        // /v1/messages 的消费方是 Anthropic SDK:401 也必须是 Anthropic 形,
        // 否则 SDK 解析不出结构化错误(与下方 415/上游错误路径同口径)。
        if (pathname === '/v1/messages' || pathname === '/v1/messages/') {
          writeAnthropicError(res, 401, 'authentication_error', 'missing or invalid authorization')
        } else {
          writeUnauthorized(res)
        }
        return
      }
      if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map(model => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: options.kind,
          })),
        })
        return
      }
      if (req.method === 'POST' && (pathname === '/v1/chat/completions' || pathname === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      if (req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/v1/messages/')) {
        await anthropicMessages(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error: unknown) {
      if (error instanceof RequestBodyTooLarge) {
        // 超限是客户端错误:按语义回 413(probe-route 同场景同口径),
        // 落进兜底 500 会把排障方向带偏到"服务端内部错误"。
        if (!res.headersSent) {
          // 尾斜杠变体与 401 分支/路由匹配同口径:SDK 会带查询串或尾斜杠。
          const errPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
          if (errPath === '/v1/messages' || errPath === '/v1/messages/') {
            writeAnthropicError(res, 413, 'invalid_request_error', 'request body too large')
          } else {
            writeOpenAIError(res, 413, 'body_too_large', 'request body too large')
          }
        }
        return
      }
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeOpenAIError(res, 401, 'not_signed_in', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const prepared = prepareChatBody(raw)

    const controller = new AbortController()
    // Node ≥16 起 IncomingMessage 的 'close' 是「请求完成」而非「socket 关闭」:
    // SSE 响应头发出后客户端断开,触发的是 res 'close',req 'close' 不再触发
    // ——挂 req 会漏掉流式阶段的断开,上游照常跑完整次生成。res 'close' 在
    // 正常结束与提前断开时都触发,事后 abort 是无害 no-op。
    res.once('close', () => controller.abort())
    const result = await client.chatStream(credential, prepared, controller.signal)

    if (!result.ok) {
      // 客户端已断开（pi-ai 取消生成 / 请求中止）：响应写进已销毁的 socket
      // 只会留下无意义的 502 噪音，静默收尾。
      if (controller.signal.aborted || res.destroyed) return
      writeOpenAIError(
        res,
        KIND_STATUS[result.kind],
        result.kind,
        `${options.kind} upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    // [DONE] 探测保留上一块的尾部字节：标记恰好跨 chunk 分割时单块扫描会
    // 漏检，流中途出错就会再补发一个 [DONE]（或把截断伪装成干净收尾）。
    const DONE_MARKER = Buffer.from('[DONE]')
    let tail = Buffer.alloc(0)
    let sawDone = false
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    // 流式阶段的客户端断开必须显式取消上游:chatStream 的头超时 fuse 在头
    // 到达时已 dispose(解除 signal→fetch 的传导),abort 传不到 undici;
    // destroy 驱动 web reader 的 cancel(),上游请求才真正中止。正常收尾时
    // body 已 end,destroy 是无害 no-op。
    res.once('close', () => {
      if (!body.readableEnded) body.destroy(new Error('client disconnected mid-stream'))
    })
    body.on('data', (chunk: Buffer) => {
      const joined = Buffer.concat([tail, chunk])
      if (joined.includes(DONE_MARKER)) sawDone = true
      // 只留 marker 长度 -1 的尾部：足够拼出任何跨块分割的标记。
      tail = joined.subarray(Math.max(0, joined.length - (DONE_MARKER.length - 1)))
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-any-connect: upstream stream failed mid-flight', error)
      // 中断收尾:客户端已见过 [DONE] 的直接终结连接;没见过的补一个再终结
      // ——既不把截断伪装成干净收尾,也不让连接悬挂。
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
      else if (!res.writableEnded) res.end()
    })
    body.pipe(res)
  }

  async function anthropicMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isJsonContentType(req)) {
      writeAnthropicError(res, 415, 'invalid_request_error', 'Content-Type must be application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error: unknown) {
      writeAnthropicError(res, 401, 'authentication_error', String(error))
      return
    }

    const raw = (await readBody(req)).toString('utf8')
    const controller = new AbortController()
    // 与 chatCompletions 同口径:res 'close' 才是流式阶段的断开信号(req
    // 'close' 在响应开始后不再触发)。
    res.once('close', () => controller.abort())
    const result = await client.chatStream(credential, raw, controller.signal)

    if (!result.ok) {
      if (controller.signal.aborted || res.destroyed) return
      writeAnthropicError(
        res,
        KIND_STATUS[result.kind],
        result.kind === 'hard_credit' ? 'billing_error' : 'api_error',
        `${options.kind} upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`,
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const body = Readable.fromWeb(result.response.body as Parameters<typeof Readable.fromWeb>[0])
    res.once('close', () => {
      if (!body.readableEnded) body.destroy(new Error('client disconnected mid-stream'))
    })
    body.on('error', (error: unknown) => {
      logger?.warn('dsh-any-connect: upstream stream failed mid-flight', error)
      if (!res.writableEnded) res.end()
    })
    body.pipe(res)
  }


  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(() => resolve())
      server.closeAllConnections()
      server.once('error', reject)
    }),
  }
}
