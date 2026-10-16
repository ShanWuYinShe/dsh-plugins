import { describe, expect, it, vi } from 'vitest'
import {
  OpenCodeUpstreamClient,
  OPENCODE_READ_TOOL,
  OPENCODE_ANTHROPIC_READ_TOOL,
  OPENCODE_CLI_USER_AGENT,
  OPENCODE_FALLBACK_CREDITS,
  OPENCODE_MODELS_URL,
  OPENCODE_CHAT_COMPLETIONS_URL,
  OPENCODE_RESPONSES_URL,
  OPENCODE_ANTHROPIC_MESSAGES_URL,
  resolveProtocolFromNpm,
  resolveOpenCodeModelProtocol,
  resolveOpenCodeEndpoint,
  transformResponsesStreamToChatCompletions,
  transformAnthropicStreamToChatCompletions,
  prepareOpenCodeChatBody,
  prepareOpenCodeAnthropicBody,
  generateOpenCodeId,
  isOpenCodeFreeModelId,
  formatOpenCodeModelName,
  mergeOpenCodeCatalogue,
  type OpenCodeModelSpec,
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

describe('isOpenCodeFreeModelId', () => {
  it('正确识别免费模型与收费模型', () => {
    expect(isOpenCodeFreeModelId('big-pickle')).toBe(true)
    expect(isOpenCodeFreeModelId('cat-jam-free')).toBe(true)
    expect(isOpenCodeFreeModelId('deepseek-v4.1-flash-free')).toBe(true)
    expect(isOpenCodeFreeModelId('muse-spark-1.2-contributor-free')).toBe(true)

    expect(isOpenCodeFreeModelId('claude-opus-5-5')).toBe(false)
    expect(isOpenCodeFreeModelId('deepseek-v4.1-flash')).toBe(false)
    expect(isOpenCodeFreeModelId('gpt-5.5')).toBe(false)
    expect(isOpenCodeFreeModelId('')).toBe(false)
  })
})

describe('formatOpenCodeModelName', () => {
  it('正确格式化固定字典与动态模型名称', () => {
    expect(formatOpenCodeModelName('big-pickle')).toBe('Big Pickle')
    expect(formatOpenCodeModelName('cat-jam-free')).toBe('Cat Jam Free')
    expect(formatOpenCodeModelName('nemotron-3.5-super-vl-free')).toBe('Nemotron 3.5 Super VL Free')
    expect(formatOpenCodeModelName('custom-model-vl-free')).toBe('Custom Model VL Free')
  })
})

describe('mergeOpenCodeCatalogue', () => {
  it('合流上游在线 ID 并优先应用规格元数据', () => {
    const specs = new Map<string, OpenCodeModelSpec>([
      [
        'space-bunny-free',
        {
          name: 'Space Bunny Official',
          limit: { context: 1048576, output: 524288 },
          attachment: true,
          reasoning: true,
        },
      ],
      [
        'brand-new-free',
        {
          limit: { context: 500000, output: 64000 },
          attachment: false,
          provider: { npm: '@ai-sdk/anthropic' },
        },
      ],
    ])

    const upstreamIds = ['space-bunny-free', 'claude-opus-5-5', 'brand-new-free']
    const merged = mergeOpenCodeCatalogue(FALLBACK_OPENCODE_MODELS, upstreamIds, specs)

    // 收费模型应被过滤
    expect(merged).toHaveLength(2)
    expect(merged.some(m => m.id === 'claude-opus-5-5')).toBe(false)

    const spaceBunny = merged.find(m => m.id === 'space-bunny-free')
    expect(spaceBunny?.name).toBe('Space Bunny Official')
    expect(spaceBunny?.contextWindow).toBe(1048576)
    expect(spaceBunny?.maxTokens).toBe(524288)
    expect(spaceBunny?.supportsImages).toBe(true)

    const brandNew = merged.find(m => m.id === 'brand-new-free')
    expect(brandNew?.contextWindow).toBe(500000)
    expect(brandNew?.maxTokens).toBe(64000)
    expect(brandNew?.wireProtocol).toBe('anthropic-messages')
  })

  it('上游无有效免费模型时回退 fallbackModels', () => {
    const merged = mergeOpenCodeCatalogue(FALLBACK_OPENCODE_MODELS, ['paid-model-1', 'paid-model-2'])
    expect(merged).toEqual(FALLBACK_OPENCODE_MODELS)
  })
})

describe('OpenCodeUpstreamClient.fetchModels', () => {
  it('动态拉取上游在线模型并结合 specs 组装完整元数据', async () => {
    const fakeSpecs = new Map<string, OpenCodeModelSpec>([
      [
        'test-free-1',
        {
          name: 'Test Free One',
          limit: { context: 1000000, output: 65536 },
          attachment: true,
          reasoning: true,
        },
      ],
    ])
    const client = new OpenCodeUpstreamClient({
      models: FALLBACK_OPENCODE_MODELS,
      specs: fakeSpecs,
    })

    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'test-free-1', object: 'model' },
          { id: 'paid-gpt-5', object: 'model' },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const models = await client.fetchModels(makeCredential())
      expect(capturedUrl).toBe(OPENCODE_MODELS_URL)
      expect(capturedHeaders['user-agent']).toBe(OPENCODE_CLI_USER_AGENT)
      expect(capturedHeaders['Accept']).toBe('application/json')

      expect(models).toHaveLength(1)
      expect(models[0]?.id).toBe('test-free-1')
      expect(models[0]?.contextWindow).toBe(1000000)
      expect(models[0]?.maxTokens).toBe(65536)
      expect(models[0]?.supportsImages).toBe(true)
      expect(models[0]?.billing?.free).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('上游返回非 200 或异常时安全降级到 fallback 免费模型', async () => {
    const client = new OpenCodeUpstreamClient({ models: FALLBACK_OPENCODE_MODELS })
    const fakeFetch = vi.fn(async () => {
      return new Response('Internal Server Error', { status: 500 })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const models = await client.fetchModels(makeCredential())
      expect(models).toEqual(FALLBACK_OPENCODE_MODELS)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('上游网络抛错或超时时安全降级到 fallback 免费模型', async () => {
    const client = new OpenCodeUpstreamClient({ models: FALLBACK_OPENCODE_MODELS })
    const fakeFetch = vi.fn(async () => {
      throw new Error('Network offline or ECONNREFUSED')
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const models = await client.fetchModels(makeCredential())
      expect(models).toEqual(FALLBACK_OPENCODE_MODELS)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('上游返回空列表时安全降级到 fallback 免费模型', async () => {
    const client = new OpenCodeUpstreamClient({ models: FALLBACK_OPENCODE_MODELS })
    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const models = await client.fetchModels(makeCredential())
      expect(models).toEqual(FALLBACK_OPENCODE_MODELS)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

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

describe('resolveProtocolFromNpm', () => {
  it('正确根据官方 SDK 包名解析协议规范', () => {
    expect(resolveProtocolFromNpm('@ai-sdk/anthropic')).toBe('anthropic-messages')
    expect(resolveProtocolFromNpm('@ai-sdk/openai')).toBe('responses')
    expect(resolveProtocolFromNpm('@ai-sdk/openai-compatible')).toBe('chat-completions')
    expect(resolveProtocolFromNpm('')).toBe('chat-completions')
    expect(resolveProtocolFromNpm(undefined)).toBe('chat-completions')
    expect(resolveProtocolFromNpm('unknown-npm-pkg')).toBe('chat-completions')
  })
})

describe('prepareOpenCodeAnthropicBody', () => {
  it('规范化 messages、提升 system 提示词、设置 max_tokens 并注入 Anthropic 工具守卫', () => {
    const raw = JSON.stringify({
      model: 'qwen3.6-plus-free',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'write a poem' },
      ],
      temperature: 0.7,
    })
    const prepared = prepareOpenCodeAnthropicBody(raw)
    const json = JSON.parse(prepared)

    expect(json.system).toBe('You are a helpful assistant.')
    expect(json.stream).toBe(true)
    expect(json.max_tokens).toBe(4096)
    expect(json.temperature).toBe(0.7)
    expect(json.messages).toHaveLength(3)
    expect(json.messages[0]).toEqual({ role: 'user', content: 'hello' })
    expect(json.messages[1]).toEqual({ role: 'assistant', content: 'hi' })
    expect(json.messages[2]).toEqual({ role: 'user', content: 'write a poem' })

    // 工具守卫验证
    expect(json.tools).toBeDefined()
    expect(json.tools).toContainEqual(OPENCODE_ANTHROPIC_READ_TOOL)
  })

  it('保留已有 Anthropic 格式 tools 并追加 read 工具', () => {
    const customTool = {
      name: 'calc',
      description: 'calculate math',
      input_schema: { type: 'object' },
    }
    const raw = JSON.stringify({
      model: 'minimax-m2.1-free',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'do calc' }],
      tools: [customTool],
    })
    const prepared = prepareOpenCodeAnthropicBody(raw)
    const json = JSON.parse(prepared)

    expect(json.max_tokens).toBe(8192)
    expect(json.tools).toHaveLength(2)
    expect(json.tools[0]).toEqual(customTool)
    expect(json.tools[1]).toEqual(OPENCODE_ANTHROPIC_READ_TOOL)
  })

  it('转换 OpenAI function tool 格式为 Anthropic tool 格式', () => {
    const openAiTool = {
      type: 'function',
      function: {
        name: 'search',
        description: 'web search',
        parameters: { type: 'object', properties: {} },
      },
    }
    const raw = JSON.stringify({
      model: 'qwen3.6-plus-free',
      messages: [{ role: 'user', content: 'search something' }],
      tools: [openAiTool],
    })
    const prepared = prepareOpenCodeAnthropicBody(raw)
    const json = JSON.parse(prepared)

    expect(json.tools).toHaveLength(2)
    expect(json.tools[0]).toEqual({
      name: 'search',
      description: 'web search',
      input_schema: { type: 'object', properties: {} },
    })
    expect(json.tools[1]).toEqual(OPENCODE_ANTHROPIC_READ_TOOL)
  })

  it('处理非法 JSON 时安全回退原字符串', () => {
    const invalid = '{ broken json'
    expect(prepareOpenCodeAnthropicBody(invalid)).toBe(invalid)
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
      expect(capturedUrl).toBe(OPENCODE_CHAT_COMPLETIONS_URL)
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

  it('chatStream 针对 Muse 模型自动路由至 responses 端点并转码响应流', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential()

    let capturedUrl = ''
    const fakeResponsesStream = [
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_muse_test_123","model":"muse-spark-1.3-contributor-free"}}\n\n',
      'event: response.reasoning_text.delta\n',
      'data: {"type":"response.reasoning_text.delta","delta":"thinking..."}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"Hello world!"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed"}\n\n',
    ].join('')

    const enc = new TextEncoder()
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url)
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(fakeResponsesStream))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const result = await client.chatStream(
        cred,
        JSON.stringify({
          model: 'muse-spark-1.3-contributor-free',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      )
      expect(result.ok).toBe(true)
      expect(capturedUrl).toBe(OPENCODE_RESPONSES_URL)

      if (result.ok && result.response.body) {
        const reader = result.response.body.getReader()
        const dec = new TextDecoder()
        let received = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          received += dec.decode(value)
        }

        expect(received).toContain('"object":"chat.completion.chunk"')
        expect(received).toContain('"reasoning_content":"thinking..."')
        expect(received).toContain('"content":"Hello world!"')
        expect(received).toContain('"finish_reason":"stop"')
        expect(received).toContain('data: [DONE]')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('chatStream 针对 Anthropic 协议模型自动路由至 messages 端点并转码响应流', async () => {
    const client = new OpenCodeUpstreamClient()
    const cred = makeCredential()

    let capturedUrl = ''
    let capturedBody = ''
    const fakeAnthropicStream = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_anthropic_123","model":"qwen3.6-plus-free","role":"assistant"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"thinking deep..."}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello from Anthropic protocol!"}}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join('')

    const enc = new TextEncoder()
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = String(init?.body ?? '')
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(fakeAnthropicStream))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof fetch

    try {
      const result = await client.chatStream(
        cred,
        JSON.stringify({
          model: 'qwen3.6-plus-free',
          messages: [
            { role: 'system', content: 'You are an AI assistant.' },
            { role: 'user', content: 'hello' },
          ],
        }),
      )
      expect(result.ok).toBe(true)
      expect(capturedUrl).toBe(OPENCODE_ANTHROPIC_MESSAGES_URL)

      // 验证 body 已经由 prepareOpenCodeAnthropicBody 处理
      const parsedBody = JSON.parse(capturedBody)
      expect(parsedBody.system).toBe('You are an AI assistant.')
      expect(parsedBody.max_tokens).toBe(4096)
      expect(parsedBody.tools).toContainEqual(OPENCODE_ANTHROPIC_READ_TOOL)

      if (result.ok && result.response.body) {
        const reader = result.response.body.getReader()
        const dec = new TextDecoder()
        let received = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          received += dec.decode(value)
        }

        expect(received).toContain('"object":"chat.completion.chunk"')
        expect(received).toContain('"reasoning_content":"thinking deep..."')
        expect(received).toContain('"content":"Hello from Anthropic protocol!"')
        expect(received).toContain('"finish_reason":"stop"')
        expect(received).toContain('data: [DONE]')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('resolveOpenCodeModelProtocol & resolveOpenCodeEndpoint', () => {
  it('正确根据官方 spec.provider.npm 决议协议与端点', () => {
    const specs = new Map<string, OpenCodeModelSpec>([
      ['custom-responses-model', { provider: { npm: '@ai-sdk/openai' } }],
      ['custom-anthropic-model', { provider: { npm: '@ai-sdk/anthropic' } }],
      ['custom-chat-model', { provider: { npm: '@ai-sdk/openai-compatible' } }],
    ])

    expect(resolveOpenCodeModelProtocol('custom-responses-model', specs)).toBe('responses')
    expect(resolveOpenCodeEndpoint('custom-responses-model', specs)).toBe(OPENCODE_RESPONSES_URL)

    expect(resolveOpenCodeModelProtocol('custom-anthropic-model', specs)).toBe('anthropic-messages')
    expect(resolveOpenCodeEndpoint('custom-anthropic-model', specs)).toBe(OPENCODE_ANTHROPIC_MESSAGES_URL)

    expect(resolveOpenCodeModelProtocol('custom-chat-model', specs)).toBe('chat-completions')
    expect(resolveOpenCodeEndpoint('custom-chat-model', specs)).toBe(OPENCODE_CHAT_COMPLETIONS_URL)
  })

  it('优先尊重 specs 或 models 中明确标记的 wireProtocol', () => {
    const specs = new Map<string, OpenCodeModelSpec>([
      ['override-model', { wireProtocol: 'anthropic-messages', provider: { npm: '@ai-sdk/openai' } }],
    ])
    expect(resolveOpenCodeModelProtocol('override-model', specs)).toBe('anthropic-messages')
    expect(resolveOpenCodeEndpoint('override-model', specs)).toBe(OPENCODE_ANTHROPIC_MESSAGES_URL)
  })

  it('正确解析 fallback 目录中预设的各模型协议', () => {
    expect(resolveOpenCodeModelProtocol('muse-spark-1.2-contributor-free')).toBe('responses')
    expect(resolveOpenCodeEndpoint('muse-spark-1.2-contributor-free')).toBe(OPENCODE_RESPONSES_URL)

    expect(resolveOpenCodeModelProtocol('muse-spark-1.3-contributor-free')).toBe('responses')
    expect(resolveOpenCodeEndpoint('muse-spark-1.3-contributor-free')).toBe(OPENCODE_RESPONSES_URL)

    expect(resolveOpenCodeModelProtocol('qwen3.6-plus-free')).toBe('anthropic-messages')
    expect(resolveOpenCodeEndpoint('qwen3.6-plus-free')).toBe(OPENCODE_ANTHROPIC_MESSAGES_URL)

    expect(resolveOpenCodeModelProtocol('minimax-m2.1-free')).toBe('chat-completions')
    expect(resolveOpenCodeEndpoint('minimax-m2.1-free')).toBe(OPENCODE_CHAT_COMPLETIONS_URL)

    expect(resolveOpenCodeModelProtocol('deepseek-v4.1-flash-free')).toBe('chat-completions')
    expect(resolveOpenCodeEndpoint('deepseek-v4.1-flash-free')).toBe(OPENCODE_CHAT_COMPLETIONS_URL)
  })

  it('启发式规则优先识别模型家族', () => {
    expect(resolveOpenCodeModelProtocol('muse-preview')).toBe('responses')
    expect(resolveOpenCodeEndpoint('muse-preview')).toBe(OPENCODE_RESPONSES_URL)

    expect(resolveOpenCodeModelProtocol('gpt-5.5-free')).toBe('responses')
    expect(resolveOpenCodeEndpoint('gpt-5.5-free')).toBe(OPENCODE_RESPONSES_URL)

    expect(resolveOpenCodeModelProtocol('claude-3-7-sonnet-free')).toBe('anthropic-messages')
    expect(resolveOpenCodeEndpoint('claude-3-7-sonnet-free')).toBe(OPENCODE_ANTHROPIC_MESSAGES_URL)

    expect(resolveOpenCodeModelProtocol('qwen-flash-free')).toBe('anthropic-messages')
    expect(resolveOpenCodeEndpoint('qwen-flash-free')).toBe(OPENCODE_ANTHROPIC_MESSAGES_URL)

    // 官方文档中 qwen3.8-max 明确走 chat-completions
    expect(resolveOpenCodeModelProtocol('qwen3.8-max-free')).toBe('chat-completions')
    expect(resolveOpenCodeEndpoint('qwen3.8-max-free')).toBe(OPENCODE_CHAT_COMPLETIONS_URL)

    expect(resolveOpenCodeModelProtocol('big-pickle')).toBe('chat-completions')
    expect(resolveOpenCodeEndpoint('big-pickle')).toBe(OPENCODE_CHAT_COMPLETIONS_URL)
  })
})

describe('transformResponsesStreamToChatCompletions', () => {
  it('正确将 Responses API 事件流转换为 Chat Completions SSE 格式', async () => {
    const mockSse = [
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_abc","model":"muse-spark-1.3"}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","item":{"role":"assistant"}}\n\n',
      'event: response.reasoning_text.delta\n',
      'data: {"type":"response.reasoning_text.delta","delta":"thinking"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"result"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed"}\n\n',
    ].join('')

    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const inStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(mockSse))
        c.close()
      },
    })

    const transformed = transformResponsesStreamToChatCompletions(inStream, 'muse-spark-1.3')
    const reader = transformed.getReader()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value)
    }

    expect(out).toContain('"role":"assistant"')
    expect(out).toContain('"reasoning_content":"thinking"')
    expect(out).toContain('"content":"result"')
    expect(out).toContain('"finish_reason":"stop"')
    expect(out).toContain('data: [DONE]')
  })

  it('透传上游已是标准 chat.completion.chunk 的流', async () => {
    const mockSse = 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const inStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(mockSse))
        c.close()
      },
    })

    const transformed = transformResponsesStreamToChatCompletions(inStream, 'test-model')
    const reader = transformed.getReader()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value)
    }

    expect(out).toContain('{"object":"chat.completion.chunk","choices":[{"delta":{"content":"ok"}}]}')
    expect(out).toContain('data: [DONE]')
  })
})

describe('transformAnthropicStreamToChatCompletions', () => {
  it('正确将 Anthropic Messages SSE 事件流转换为 Chat Completions SSE 格式', async () => {
    const mockAnthropicSse = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_test_anthropic","model":"qwen3.6-plus-free","role":"assistant","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan step 1"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Final response content"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":25}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join('')

    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const inStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(mockAnthropicSse))
        c.close()
      },
    })

    const transformed = transformAnthropicStreamToChatCompletions(inStream, 'qwen3.6-plus-free')
    const reader = transformed.getReader()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value)
    }

    expect(out).toContain('"role":"assistant"')
    expect(out).toContain('"reasoning_content":"Plan step 1"')
    expect(out).toContain('"content":"Final response content"')
    expect(out).toContain('"finish_reason":"stop"')
    expect(out).toContain('data: [DONE]')
  })

  it('透传已经是标准 chat.completion.chunk 的流', async () => {
    const mockSse = 'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"direct"}}]}\n\ndata: [DONE]\n\n'
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const inStream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(mockSse))
        c.close()
      },
    })

    const transformed = transformAnthropicStreamToChatCompletions(inStream, 'test-model')
    const reader = transformed.getReader()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value)
    }

    expect(out).toContain('{"object":"chat.completion.chunk","choices":[{"delta":{"content":"direct"}}]}')
    expect(out).toContain('data: [DONE]')
  })
})

