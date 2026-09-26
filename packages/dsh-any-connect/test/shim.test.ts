import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.js'
import { WorkBuddyCatalog, FALLBACK_WORKBUDDY_MODELS } from '../src/catalog.js'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.js'
import { CN_VARIANT } from '../src/variants.js'
import type { WorkBuddyChatResult } from '../src/upstream.js'

const CLEANUP: (() => Promise<void>)[] = []

// ReadableStream.from 运行时可用（Node ≥ 20.6），TS 的 ES2022/DOM 类型库尚未
// 收录该静态方法，这里按实际签名断言（仅类型层面，运行时行为不变）。
const readableStreamFrom = (ReadableStream as unknown as {
  from: (source: AsyncIterable<Uint8Array>) => ReadableStream<Uint8Array>
}).from

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
    variant: CN_VARIANT,
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
    kind: 'workbuddy',
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
    // The fallback roster tracks the live `cli` agent's models (16 as of the
    // 2026-09-15 re-verification against desktop 5.5.6). Asserted by identity
    // rather than by count so a roster refresh does not fail this test.
    expect(ids.length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('kimi-k2.8-preview')
    expect(ids).not.toContain('deepseek-v4-flash')
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

  it('streams an Anthropic message on /v1/messages authenticated by x-api-key', async () => {
    const encoder = new TextEncoder()
    async function* source() {
      yield encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n')
    }
    const harness = await startShim(() => ({
      ok: true,
      response: new Response(readableStreamFrom(source()), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': harness.shim.token(),
      },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain('hello')
    expect(harness.upstreamBodies).toHaveLength(1)
  })

  it('maps an upstream credit failure on /v1/messages onto Anthropic error format', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 402,
      kind: 'hard_credit',
      message: '积分不足',
    }))
    const response = await fetch(`${harness.shim.baseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': harness.shim.token(),
      },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })
    expect(response.status).toBe(402)
    const body = await response.json() as { type: string, error: { type: string, message: string } }
    expect(body.type).toBe('error')
    expect(body.error.type).toBe('billing_error')
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

  it('rejects a loopback request with a wrong x-api-key', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'unused' }))
    const port = Number(new URL(harness.shim.baseUrl()).port)
    const res = await rawRequest({
      port,
      method: 'POST',
      path: '/v1/messages',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        'x-api-key': 'not-the-real-secret',
      },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(res.status).toBe(401)
    // 401 必须是 Anthropic 形错误体(SDK 靠 type 字段解析结构化错误):
    // 回归成 OpenAI 形 writeUnauthorized 时,SDK 解析直接退化,测试必须红。
    const errBody = JSON.parse(res.body) as { type?: string; error?: { type?: string } }
    expect(errBody.type).toBe('error')
    expect(errBody.error?.type).toBe('authentication_error')
    expect(harness.upstreamBodies).toHaveLength(0)
  })
  it('maps a credential resolution failure to 401 on both routes with kind-shaped bodies', async () => {
    // 回归钉死:token 过期且刷新失败时用户命中的主路径——store.resolve()
    // 抛错必须映射为各自 SDK 可解析的 401 形状(此前零覆盖,错误体形状
    // 漂移测试仍绿)。桌面文件不存在 + 无插件副本 = resolve() 必抛。
    const dir = await mkdtemp(join(tmpdir(), 'wb-shim-noauth-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const store = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      desktopPath: join(dir, 'missing.info'),
      ownPath: join(dir, 'own.json'),
      refresh: async () => ({ accessToken: 'unused' }),
    })
    const shim = createWorkBuddyShim({
      kind: 'workbuddy',
      store,
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(): Promise<WorkBuddyChatResult> { throw new Error('must not reach upstream') },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())
    const port = Number(new URL(shim.baseUrl()).port)

    // OpenAI 形:/v1/chat/completions → 401 not_signed_in
    const openai = await rawRequest({
      port, method: 'POST', path: '/v1/chat/completions',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(openai.status).toBe(401)
    const openaiBody = JSON.parse(openai.body) as { error?: { code?: string; message?: string } }
    expect(openaiBody.error?.code).toBe('not_signed_in')

    // Anthropic 形:/v1/messages → 401 authentication_error
    const anthropic = await rawRequest({
      port, method: 'POST', path: '/v1/messages',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'x-api-key': shim.token() },
      body: JSON.stringify({ model: 'auto', messages: [] }),
    })
    expect(anthropic.status).toBe(401)
    const anthropicBody = JSON.parse(anthropic.body) as { type?: string; error?: { type?: string; message?: string } }
    expect(anthropicBody.type).toBe('error')
    expect(anthropicBody.error?.type).toBe('authentication_error')
    expect(anthropicBody.error?.message).toContain('no signed-in')
  })

  it('detects [DONE] split across stream chunks (no duplicate marker on mid-flight error)', async () => {
    // 标记恰好跨 chunk 分割时,单块扫描会漏检 sawDone,流中途出错就会再补
    // 一个 [DONE](客户端看到重复标记,截断被伪装成干净收尾)。
    //
    // 用 async generator 造流,**不要**用 `start` + `setTimeout(error)`:
    // 后者与消费赛跑——慢机器上 error 先于排队块被消费,正文丢失,断言
    // `toContain('你好')` 随机失败(2026-09-15 CI 抖动即此因)。生成器只在
    // 消费方请求下一块时才推进,因此三块必然依次送达,`throw` 随后把流
    // 置错——事件顺序确定为 data×N → error。
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\ndata: [DON',
      'E]\n\n',
    ]
    async function* source() {
      for (const chunk of chunks) yield encoder.encode(chunk)
      throw new Error('upstream reset mid-flight')
    }
    const harness = await startShim(() => ({
      ok: true,
      response: new Response(readableStreamFrom(source()), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
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
      variant: CN_VARIANT,
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => ({ accessToken: 'unused' }),
    })
    let entered = false
    let seenSignal: AbortSignal | undefined
    let calls = 0
    const shim = createWorkBuddyShim({
      kind: 'workbuddy',
      store,
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream(_credential, _body, signal) {
          calls += 1
          entered = true
          // 首次调用(将被断开的那次)记录 signal 并等待 abort;后续调用
          // (断开后的存活验证)返回正常流,否则会复用等 abort 的挂起逻辑。
          if (calls === 1) {
            seenSignal = signal
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve()
              else signal?.addEventListener('abort', () => resolve())
            })
            return { ok: false, status: 0, kind: 'client' as const, message: 'client disconnected before upstream response' }
          }
          return { ok: true, response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) }
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
      CLEANUP.push(async () => clearInterval(abortOnceEntered))
    })
    expect(entered).toBe(true)
    // 显式断言 abort 传导:客户端断开必须 abort 传给 chatStream 的 signal
    // (上游依赖它取消请求),不能只靠「没崩」这种间接绊线。
    expect(seenSignal?.aborted).toBe(true)
    // 断开后 shim 仍健康:后续正常请求照常工作(服务存活验证,替代仅靠
    // vitest unhandled-rejection 绊线的弱保证)。
    const after = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'again' }] }),
    })
    expect(after.status).toBe(200)
    await after.text()
  })
  it('cancels the upstream stream when the client disconnects mid-flight', async () => {
    // 回归:Node ≥16 起 req 'close' 在响应开始后不再触发(那是「请求完成」
    // 语义),流式阶段客户端断开必须靠 res 'close' + 显式 destroy body——
    // 此前两条都没有,上游 SSE 被照常消费到生成结束(白烧积分)。
    // 断言:客户端收到首块后断开,上游 web body 的 cancel() 被调用。
    const dir = await mkdtemp(join(tmpdir(), 'shim-midflight-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, "desktop.json"), JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1' },
    }))
    const store = new WorkBuddyCredentialStore({
      variant: CN_VARIANT,
      desktopPath: join(dir, "desktop.json"),
      ownPath: join(dir, "own.json"),
      refresh: async () => ({ accessToken: 'unused' }),
    })
    let cancelled = false
    const shim = createWorkBuddyShim({
      kind: "workbuddy",
      store,
      catalog: new WorkBuddyCatalog(),
      client: {
        async chatStream() {
          const webBody = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
              // 不 close:上游生成还在继续,等客户端断开来取消。
            },
            cancel() { cancelled = true },
          })
          return { ok: true as const, response: new Response(webBody, { status: 200 }) }
        },
      },
    })
    await shim.ready
    CLEANUP.push(() => shim.close())

    await new Promise<void>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port: Number(new URL(shim.baseUrl()).port),
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json", authorization: `Bearer ${shim.token()}` },
      }, (res) => {
        res.on("data", () => {
          // 收到首块(SSE 头已发、pipe 已建立)再断开,精确复现流式阶段断开。
          req.destroy()
        })
        res.on("error", () => {})
      })
      req.on("error", () => {}) // 客户端主动断开:服务端 reset 是预期
      req.end(JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }))
      const waitCancelled = setInterval(() => {
        if (cancelled) {
          clearInterval(waitCancelled)
          resolve()
        }
      }, 10)
      CLEANUP.push(async () => clearInterval(waitCancelled))
      // 兜底:8s 内未被取消即失败(避免悬挂)。
      setTimeout(resolve, 8000)
    })
    expect(cancelled).toBe(true)
  })
})
