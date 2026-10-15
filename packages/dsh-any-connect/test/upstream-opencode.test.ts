import { describe, expect, it, vi } from 'vitest'
import {
  OpenCodeUpstreamClient,
  OPENCODE_READ_TOOL,
  OPENCODE_CLI_USER_AGENT,
  OPENCODE_FALLBACK_CREDITS,
  prepareOpenCodeChatBody,
  generateOpenCodeId,
} from '../src/upstream-opencode.js'
import { FALLBACK_OPENCODE_MODELS } from '../src/catalog.js'
import type { WorkBuddyCredential } from '../src/auth-types.js'

function makeCredential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'public',
    refreshToken: '',
    expiresAtMs: Date.now() + 100_000,
    domain: 'opencode.ai',
    uid: 'opencode-public',
    source: 'desktop',
    ...overrides,
  }
}

describe('prepareOpenCodeChatBody', () => {
  it('注入 read tool 与 stream: true 当请求未带 tools 时', () => {
    const raw = JSON.stringify({
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const prepared = prepareOpenCodeChatBody(raw)
    const json = JSON.parse(prepared)

    expect(json.stream).toBe(true)
    expect(json.stream_options).toEqual({ include_usage: true })
    expect(json.tool_choice).toBe('auto')
    expect(json.tools).toBeDefined()
    expect(json.tools).toHaveLength(1)
    expect(json.tools[0]).toEqual(OPENCODE_READ_TOOL)
  })

  it('保留已有 tools 并追加 read tool 当缺少 read 工具时', () => {
    const customTool = {
      type: 'function',
      function: { name: 'calculator', parameters: {} },
    }
    const raw = JSON.stringify({
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: 'calc' }],
      tools: [customTool],
    })
    const prepared = prepareOpenCodeChatBody(raw)
    const json = JSON.parse(prepared)

    expect(json.stream).toBe(true)
    expect(json.tools).toHaveLength(2)
    expect(json.tools[0]).toEqual(customTool)
    expect(json.tools[1]).toEqual(OPENCODE_READ_TOOL)
  })

  it('不重复追加当已有 read tool 时', () => {
    const raw = JSON.stringify({
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: 'test' }],
      tools: [OPENCODE_READ_TOOL],
    })
    const prepared = prepareOpenCodeChatBody(raw)
    const json = JSON.parse(prepared)

    expect(json.tools).toHaveLength(1)
  })

  it('处理非法 JSON 时安全回退原字符串', () => {
    const invalid = '{ not valid json'
    expect(prepareOpenCodeChatBody(invalid)).toBe(invalid)
  })
})

describe('generateOpenCodeId', () => {
  it('生成合法长度与格式的 descending (Session) ID', () => {
    const id = generateOpenCodeId(true, 1792073905435)
    expect(id).toHaveLength(26)
    // 逆向取证验证：1792073905435 的 ones complement 前缀为 ec0124ae4ffe
    expect(id.startsWith('ec0124ae4ffe')).toBe(true)
    expect(/^[0-9a-f]{12}[0-9a-zA-Z]{14}$/.test(id)).toBe(true)
  })

  it('生成合法长度与格式的 ascending (Message) ID', () => {
    const id = generateOpenCodeId(false, 1792073905435)
    expect(id).toHaveLength(26)
    // 逆向取证验证：1792073905435 的普通时间戳前缀为 13fedb51b00X (X 为序列计数)
    expect(id.startsWith('13fedb51b00')).toBe(true)
    expect(/^[0-9a-f]{12}[0-9a-zA-Z]{14}$/.test(id)).toBe(true)
  })
})

describe('OpenCodeUpstreamClient', () => {
  it('fetchModels 返回配置的模型或 fallback 免费模型', async () => {
    const client = new OpenCodeUpstreamClient({ models: FALLBACK_OPENCODE_MODELS })
    const cred = makeCredential()
    const models = await client.fetchModels(cred)
    expect(models).toHaveLength(FALLBACK_OPENCODE_MODELS.length)
    expect(models.some(m => m.id === 'deepseek-v4.1-flash-free')).toBe(true)
    expect(models.some(m => m.id === 'mimo-v2.6-flash-free')).toBe(true)
  })

  it('FALLBACK_OPENCODE_MODELS 拥有正确的官方真实上下文与限制', () => {
    const spaceBunny = FALLBACK_OPENCODE_MODELS.find(m => m.id === 'space-bunny-free')
    expect(spaceBunny?.contextWindow).toBe(1048576)
    expect(spaceBunny?.maxTokens).toBe(524288)
    expect(spaceBunny?.supportsImages).toBe(true)

    const dsFlash = FALLBACK_OPENCODE_MODELS.find(m => m.id === 'deepseek-v4.1-flash-free')
    expect(dsFlash?.contextWindow).toBe(200000)
    expect(dsFlash?.maxTokens).toBe(32000)
    expect(dsFlash?.supportsImages).toBe(true)

    const step5 = FALLBACK_OPENCODE_MODELS.find(m => m.id === 'step-5-preview-free')
    expect(step5?.contextWindow).toBe(1000000)
    expect(step5?.maxTokens).toBe(65536)
  })

  it('fetchCredits 返回无限免费模型额度', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential()
    const credits = await client.fetchCredits(cred)
    expect(credits).toEqual(OPENCODE_FALLBACK_CREDITS)
    expect(credits.total).toBeGreaterThan(0)
    expect(credits.accounts[0]?.packageName).toBe('OpenCode Free Tier')
  })

  it('refreshToken 原样回显 accessToken', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential({ accessToken: 'my-token' })
    const outcome = await client.refreshToken(cred)
    expect(outcome.accessToken).toBe('my-token')
  })

  it('probeEffort 默认返回 200 streamed', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential()
    const probe = await client.probeEffort(cred, 'deepseek-v4.1-flash-free', 'high', new AbortController().signal)
    expect(probe).toEqual({ status: 200, streamed: true })
  })

  it('chatStream 发出正确的过闸 headers 与带 read tool 的 payload', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential({ accessToken: 'test-custom-key' })

    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''

    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      capturedBody = String(init?.body ?? '')
      return new Response('event: data\ndata: {"choices":[]}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const inputBody = JSON.stringify({
        model: 'deepseek-v4.1-flash-free',
        messages: [{ role: 'user', content: 'ping' }],
      })

      const result = await client.chatStream(cred, inputBody)
      expect(result.ok).toBe(true)
      expect(capturedUrl).toBe('https://opencode.ai/inference/v1/chat/completions')
      expect(capturedHeaders['Authorization']).toBe('Bearer test-custom-key')
      expect(capturedHeaders['user-agent']).toBe(OPENCODE_CLI_USER_AGENT)
      expect(capturedHeaders['x-opencode-client']).toBe('cli')
      expect(capturedHeaders['x-opencode-project']).toBe('5da9b72c6f3d58f67b560a1dd82e3c067c3fbd18')
      expect(capturedHeaders['x-opencode-session']).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/)
      expect(capturedHeaders['x-opencode-request']).toMatch(/^msg_[0-9a-f]{12}[0-9a-zA-Z]{14}$/)
      expect(capturedHeaders['x-opencode-session-id']).toBe(capturedHeaders['x-opencode-session'])
      expect(capturedHeaders['x-session-affinity']).toBe(capturedHeaders['x-opencode-session'])
      expect(capturedHeaders['x-session-id']).toBe(capturedHeaders['x-opencode-session'])

      const bodyObj = JSON.parse(capturedBody)
      expect(bodyObj.stream).toBe(true)
      expect(bodyObj.stream_options).toEqual({ include_usage: true })
      expect(bodyObj.tool_choice).toBe('auto')
      expect(bodyObj.tools).toEqual([OPENCODE_READ_TOOL])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('chatStream 无 token 时默认使用 Bearer public 过闸', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential({ accessToken: '' })

    let authHeader = ''
    const fakeFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      authHeader = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? ''
      return new Response('event: data\ndata: {"choices":[]}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      await client.chatStream(cred, JSON.stringify({ model: 'mimo-v2.6-flash-free', messages: [] }))
      expect(authHeader).toBe('Bearer public')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('chatStream 错误时返回分类好的失败结构', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential()

    const fakeFetch = vi.fn(async () => {
      return new Response('{"error": "Forbidden"}', {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const result = await client.chatStream(cred, '{}')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(403)
        expect(result.kind).toBe('auth_forbidden')
      }
    } finally {
      globalThis.fetch = originalFetch
    }

  })
})
