import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.js'
import { WorkBuddyCatalog } from '../src/catalog.js'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.js'
import type { WorkBuddyChatResult } from '../src/upstream.js'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

interface Harness {
  shim: WorkBuddyShim
  store: WorkBuddyCredentialStore
  upstreamBodies: string[]
  upstreamResponse: () => WorkBuddyChatResult
}

/** Raw HTTP request with full header control (fetch forbids overriding Host). */
function rawRequest(options: {
  port: number
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: options.port,
      method: options.method,
      path: options.path,
      headers: options.headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function startShim(upstreamResponse: () => WorkBuddyChatResult): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-shim-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const desktop = join(dir, 'workbuddy-desktop.info')
  await writeFile(desktop, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1' },
  }))
  const store = new WorkBuddyCredentialStore({
    desktopPath: desktop,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
  const harness: Harness = {
    shim: undefined as unknown as WorkBuddyShim,
    store,
    upstreamBodies: [],
    upstreamResponse,
  }
  harness.shim = createWorkBuddyShim({
    store,
    catalog: new WorkBuddyCatalog(),
    client: {
      async chatStream(_credential, bodyJson): Promise<WorkBuddyChatResult> {
        harness.upstreamBodies.push(bodyJson)
        return harness.upstreamResponse()
      },
    },
  })
  await harness.shim.ready
  CLEANUP.push(() => harness.shim.close())
  return harness
}

describe('WorkBuddy shim', () => {
  it('lists the catalog on /v1/models', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: { id: string }[] }
    const ids = body.data.map(model => model.id)
    expect(ids).toContain('auto')
    expect(ids).toContain('deepseek-v4-pro')
    // The fallback roster tracks the live `cli` agent's 15 models.
    expect(ids.length).toBe(15)
    expect(ids).toContain('hy4-preview')
    expect(ids).toContain('glm-5.3')
  })

  it('streams a successful chat completion and normalizes the body', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'auto',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'auto' },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('你好')
    expect(text).toContain('[DONE]')
    expect(harness.upstreamBodies.length).toBe(1)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['stream']).toBe(true)
    expect(forwarded['tool_choice']).toBe('auto')
  })

  it('forwards the reasoning_effort a model picker selection sends', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'xhigh',
      }),
    })
    expect(response.status).toBe(200)
    const forwarded = JSON.parse(harness.upstreamBodies[0] ?? '') as Record<string, unknown>
    expect(forwarded['reasoning_effort']).toBe('xhigh')
    expect(forwarded['stream']).toBe(true)
  })

  it('maps an upstream credit failure onto HTTP 402', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 402,
      kind: 'hard_credit',
      message: '积分不足',
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(response.status).toBe(402)
    const body = await response.json() as { error: { type: string, message: string } }
    expect(body.error.type).toBe('hard_credit')
    expect(body.error.message).toContain('积分不足')
  })

  it('answers unknown routes with 404', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/nothing`, {
      headers: { authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(response.status).toBe(404)
  })

  it('binds loopback only', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    expect(harness.shim.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('rejects a non-loopback Host header (DNS rebinding)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // A rebinding page resolves evil.com to 127.0.0.1; the browser then sends
    // Host: evil.com:<port>. fetch() forbids overriding Host, so use raw http.
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: 'evil.com' },
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('host_not_allowed')
  })

  it('accepts Host with a loopback name plus port', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'GET',
      path: '/healthz',
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${harness.shim.token()}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a browser Origin from a non-loopback site', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.com',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(403)
    expect(res.body).toContain('origin_not_allowed')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('accepts a loopback browser Origin', async () => {
    const harness = await startShim(() => ({
      ok: true,
      response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://127.0.0.1:3080',
        'content-type': 'application/json',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects a chat POST with a non-JSON Content-Type (simple-request CSRF)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'text/plain',
        authorization: `Bearer ${harness.shim.token()}`,
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(415)
    expect(res.body).toContain('unsupported_media_type')
    // Nothing reached the upstream.
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request without a bearer (local process without the secret)', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    // Everything else about this request is legitimate: loopback Host, no
    // Origin (a local process, not a browser), JSON body. Only the bearer is
    // missing — this is the shape a hostile local process would send.
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(res.body).toContain('unauthorized')
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('rejects a loopback request with a wrong bearer', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer not-the-real-secret',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(401)
    expect(harness.upstreamBodies).toHaveLength(0)
  })

  it('detects [DONE] split across stream chunks (no duplicate marker on mid-flight error)', async () => {
    // 标记恰好跨 chunk 分割时,单块扫描会漏检 sawDone,流中途出错就会再补
    // 一个 [DONE](客户端看到重复标记,截断被伪装成干净收尾)。
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DON'))
        controller.enqueue(encoder.encode('E]\n\n'))
        // 延迟 error:同步 error 会让尚未开始消费的排队块丢失。
        setTimeout(() => controller.error(new Error('upstream reset mid-flight')), 20)
      },
    })
    const harness = await startShim(() => ({
      ok: true,
      response: new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('你好')
    // 恰好一个 [DONE]:分割检测命中,错误收尾不再补发第二个。
    expect(text.split('[DONE]').length - 1).toBe(1)
  })

  it('stays silent when the client disconnects (no error written into a dead socket)', async () => {
    // chatStream 返回 client 类失败且调用方 signal 已 abort:shim 不得向
    // 已销毁的 socket 回写错误(此前会留一行无意义的 502 噪音)。
    const dir = await mkdtemp(join(tmpdir(), 'wb-shim-abort-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => ({ accessToken: 'unused' }),
    })
    let entered = false
    const shim = createWorkBuddyShim({
      store,
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(_credential, _body, signal) {
          entered = true
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve()
            else signal?.addEventListener('abort', () => resolve())
          })
          return { ok: false, status: 0, kind: 'client' as const, message: 'client disconnected before upstream response' }
        },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())

    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: Number(new URL(shim.baseUrl()).port),
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      }, () => {})
      req.on('error', () => {}) // 客户端主动断开:服务端 reset 是预期
      req.end(JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }))
      const abortOnceEntered = setInterval(() => {
        if (entered) {
          clearInterval(abortOnceEntered)
          req.destroy()
          // 断开后给服务端几个 tick 处理;若有未捕获异常或向死 socket 回写,
          // vitest 会以 unhandled rejection / 崩溃形式失败。
          setTimeout(resolve, 80)
        }
      }, 10)
      CLEANUP.push(() => clearInterval(abortOnceEntered))
    })
    expect(entered).toBe(true)
  })
})
