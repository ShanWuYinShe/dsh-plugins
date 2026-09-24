import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.js'
import { modelWithCurrentPromotion, normalizeCredits, WorkBuddyUpstreamClient } from '../src/upstream.js'

/**
 * Offline unit tests for WorkBuddyUpstreamClient, mocking the global `fetch`
 * so the multi-layer response parsing and the credit-remain selection logic in
 * `fetchCredits` are covered without a real account or network. This closes a
 * gap that previously relied solely on `scripts/live-e2e.mjs`.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

/** Build the nested upstream billing document that `fetchCredits` unwraps. */
function billingEnvelope(accounts: unknown[]): string {
  return JSON.stringify({
    code: 0,
    msg: 'ok',
    data: {
      Response: {
        Data: {
          Accounts: accounts,
        },
      },
    },
  })
}

/** Minimal Response-like object satisfying `readEnvelope` (which calls `.text()`). */
function fakeResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkBuddyUpstreamClient.fetchModels', () => {
  /** Build the models-catalog envelope that `fetchModels` unwraps. */
  function modelsEnvelope(models: unknown[], cliIds: string[]): string {
    return JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        models,
        agents: [{ name: 'cli', models: cliIds }],
      },
    })
  }

  it('propagates supportsImages per model, treating unknown or disabled as text-only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-img', name: 'Image Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
      { id: 'm-muted', name: 'Multimodal Switched Off', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true, disabledMultimodal: true },
      { id: 'm-text', name: 'Text Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: false },
      { id: 'm-unknown', name: 'No Modality Field', maxInputTokens: 100_000, maxOutputTokens: 32_000 },
      { id: 'm-noncli', name: 'Not A CLI Model', maxInputTokens: 100_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-img', 'm-muted', 'm-text', 'm-unknown']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(models).toHaveLength(4)
    expect(byId.get('m-img')?.supportsImages).toBe(true)
    expect(byId.get('m-muted')?.supportsImages).toBe(false)
    expect(byId.get('m-text')?.supportsImages).toBe(false)
    // Absent field means unknown capability; the conservative answer is text-only.
    expect(byId.get('m-unknown')?.supportsImages).toBe(false)
  })

  it('keeps the catalog shape (name, contextWindow, maxTokens) alongside the flag', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      { id: 'm-1', name: 'Model One', maxInputTokens: 168_000, maxOutputTokens: 32_000, supportsImages: true },
    ], ['m-1']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'm-1',
      name: 'Model One',
      contextWindow: 168_000,
      maxTokens: 32_000,
      supportsImages: true,
      reasoning: { supports: false, onlyReasoning: false, canDisableThinking: true },
      billing: { free: false },
    })
  })

  it('parses reasoning and billing metadata from the upstream fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      {
        id: 'm-reason',
        name: 'Reasoner',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        reasoning: { supportedEfforts: ['low', 'high', 'xhigh'], defaultEffort: 'high', canDisableThinking: true },
      },
      {
        id: 'm-free',
        name: 'Freebie',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true,
        onlyReasoning: true,
        reasoning: { canDisableThinking: false },
        credits: 'x0.00',
        tags: ['craft', 'badge:限时免费:#FF0000'],
      },
      {
        id: 'm-plain',
        name: 'Plain',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
      },
    ], ['m-reason', 'm-free', 'm-plain']))))

    const models = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    const byId = new Map(models.map(model => [model.id, model]))

    expect(byId.get('m-reason')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: false,
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    })
    expect(byId.get('m-free')?.reasoning).toEqual({
      supports: true,
      onlyReasoning: true,
      canDisableThinking: false,
    })
    expect(byId.get('m-free')?.billing).toEqual({ credits: 'x0.00', badges: ['限时免费'], free: true })
    // 带单位后缀的免费拼写（live 目录实测形态 "x0.00 credits"）同样判免费：
    // free 测的是归一化后的倍率，不是原始字符串。
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(modelsEnvelope([
      {
        id: 'm-suffixed',
        name: 'Suffixed Free',
        maxInputTokens: 100_000, maxOutputTokens: 32_000,
        supportsReasoning: true, onlyReasoning: true, reasoning: { canDisableThinking: false },
        credits: 'x0.00 credits',
        tags: ['badge:限时免费:#FF0000'],
      },
    ], ['m-suffixed']))))
    const suffixed = await new WorkBuddyUpstreamClient().fetchModels(CREDENTIAL)
    expect(suffixed[0]?.billing).toEqual({ credits: 'x0.00 credits', badges: ['限时免费'], free: true })
    // A model with no reasoning or billing fields is explicitly non-reasoning
    // (supports: false) and carries no free/badge facts.
    expect(byId.get('m-plain')?.reasoning).toEqual({
      supports: false,
      onlyReasoning: false,
      canDisableThinking: true,
    })
    expect(byId.get('m-plain')?.billing).toEqual({ free: false })
  })
})

describe('WorkBuddyUpstreamClient.fetchCredits', () => {
  it('unwraps the nested envelope and aggregates total across accounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg-a', CycleCapacitySize: 100, CycleCapacityRemain: 40 },
      { PackageName: 'pkg-b', CycleCapacitySize: 200, CycleCapacityRemain: 60 },
    ]))))

    const client = new WorkBuddyUpstreamClient()
    const credits = await client.fetchCredits(CREDENTIAL)

    expect(credits.total).toBe(100)
    expect(credits.accounts).toHaveLength(2)
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg-a', remain: 40, size: 100 })
    expect(credits.accounts[1]).toEqual({ packageName: 'pkg-b', remain: 60, size: 200 })
  })

  it('selects cycle remain when size > 0 (first branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: 30, CapacityRemain: 999 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // First branch: size>0 → cycleRemain, ignoring the larger CapacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 30, size: 100 })
  })

  it('adds not-yet-started cycle grants to a drained cyclic package', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      {
        PackageName: 'pkg',
        CycleCapacitySize: 100,
        CycleCapacityRemain: 0,
        CycleCapacityUsed: 100,
        RemainCycles: 3,
        CapacityRemain: 999,
      },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Current cycle drained but three cycles never started: the package is not
    // empty. Numerator and denominator span the same scope (1 + RemainCycles).
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 300, size: 400 })
    expect(credits.total).toBe(300)
  })

  it('selects cycle remain when there is cycle usage even without size (second branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 0, CycleCapacityRemain: 20, CycleCapacityUsed: 5, CapacityRemain: 1 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Second branch: size<=0 but cycleUsed>0 → cycleRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 20, size: 0 })
  })

  it('falls back to capacity remain when no cycle fields (third branch)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacityRemain: 77 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // Third branch: no size, no cycle → capacityRemain.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 77, size: 0 })
  })

  it('clamps a negative remain to zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CycleCapacitySize: 100, CycleCapacityRemain: -50 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.remain).toBe(0)
    expect(credits.total).toBe(0)
  })

  it('falls back to CapacitySize for size when cycle size is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { PackageName: 'pkg', CapacitySize: 500, CapacityRemain: 120 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    // size falls back to CapacitySize=500; remain from third branch = 120.
    expect(credits.accounts[0]).toEqual({ packageName: 'pkg', remain: 120, size: 500 })
  })

  it('labels a missing package name as (unnamed)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      { CycleCapacitySize: 10, CycleCapacityRemain: 5 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts[0]!.packageName).toBe('(unnamed)')
  })

  it('returns an empty list for an empty Accounts array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.total).toBe(0)
    expect(credits.accounts).toEqual([])
  })

  it('skips non-object account entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(billingEnvelope([
      null,
      'not-an-object',
      42,
      { PackageName: 'valid', CycleCapacitySize: 10, CycleCapacityRemain: 7 },
    ]))))

    const credits = await new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)
    expect(credits.accounts).toHaveLength(1)
    expect(credits.accounts[0]!.packageName).toBe('valid')
  })

  it('throws when the upstream business code is non-zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(
      JSON.stringify({ code: 1, msg: 'billing error' }),
    )))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/billing error/)
  })

  it('throws when the upstream returns non-JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('not json')))

    await expect(new WorkBuddyUpstreamClient().fetchCredits(CREDENTIAL)).rejects.toThrow(/non-JSON/)
  })
})

describe('normalizeCredits', () => {
  it('keeps a bare multiplier untouched', () => {
    expect(normalizeCredits('x0.79')).toBe('x0.79')
    expect(normalizeCredits('x0.00')).toBe('x0.00')
  })

  it('strips a trailing credits unit word', () => {
    expect(normalizeCredits('x0.79 credits')).toBe('x0.79')
    expect(normalizeCredits('x1.62 credits')).toBe('x1.62')
    expect(normalizeCredits('x0.79 CREDITS')).toBe('x0.79')
    expect(normalizeCredits('x0.79 credit')).toBe('x0.79')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeCredits('  x0.79 credits  ')).toBe('x0.79')
  })

  it('returns undefined for absent or empty values', () => {
    expect(normalizeCredits(undefined)).toBeUndefined()
    expect(normalizeCredits('')).toBeUndefined()
    expect(normalizeCredits('   ')).toBeUndefined()
    expect(normalizeCredits('credits')).toBeUndefined()
  })
})

describe('WorkBuddyUpstreamClient.chatStream', () => {
  it('returns the raw SSE response on ok and classifies non-ok bodies by content', async () => {
    const sse = { ok: true, status: 200, body: 'stream' } as unknown as Response
    vi.stubGlobal('fetch', vi.fn(async () => sse))
    const ok = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{}')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.response).toBe(sse)

    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('insufficient credit balance', false, 402)))
    const credit = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{}')
    expect(!credit.ok && credit.kind === 'hard_credit' && credit.status === 402).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse('quota exceeded somewhere', false, 500)))
    const server = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{}')
    expect(!server.ok && server.kind === 'hard_credit').toBe(true)
  })

  it('classifies a caller abort as a client disconnect, not an upstream failure', async () => {
    // 模拟 undici 语义:signal 触发时 fetch 以 AbortError reject——含已预
    // abort 的信号（真 fetch 对预 abort 立即拒；deadline 获取是异步的，调用
    // 方取消可能落在 fetch 发起前， fused 信号已是 aborted 态）。
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: { signal: AbortSignal }) => {
      if (init.signal.aborted) return Promise.reject(new Error('This operation was aborted'))
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
      })
    }))
    const client = new WorkBuddyUpstreamClient()
    const pending = client.chatStream(CREDENTIAL, '{}', controller.signal)
    controller.abort()
    const result = await pending
    expect(!result.ok && result.kind === 'client' && result.status === 0).toBe(true)
  })

  it('aborts with a server classification when upstream never returns headers', async () => {
    // 头超时兜底:上游接受连接但不返回响应头。deadline 触发 → 融合 signal
    // 中止 → fetch reject → 按 server 分类,消息带可分类的超时 code
    // （此前是裸 Error 'no response headers within …ms' 字符串）。
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn((_url: unknown, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error(String(init.signal.reason))))
      })))
      const pending = new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{}')
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await pending
      expect(!result.ok && result.kind === 'server').toBe(true)
      if (!result.ok) expect(result.message).toContain('ANY_CONNECT_HEADERS')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a server classification when the error body read fails', async () => {
    // 错误体读取失败/中止:按 server 兜底,不带上游体。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('body aborted')),
    }) as unknown as Response))
    const result = await new WorkBuddyUpstreamClient().chatStream(CREDENTIAL, '{}')
    expect(!result.ok && result.kind === 'server' && result.message === '(error body unavailable)').toBe(true)
  })
})

describe('international catalog and promotions', () => {
  const AI_CREDENTIAL = { ...CREDENTIAL, domain: 'www.workbuddy.ai' }

  function appEnvelope(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      code: 0,
      msg: 'ok',
      data: {
        models: [
          {
            id: 'hy3', name: 'Hy3', maxInputTokens: 192_000, maxOutputTokens: 64_000,
            supportsImages: true,
            reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'high'] },
          },
          {
            id: 'ctx-model', name: 'Ctx', maxInputTokens: 1_000_000, maxOutputTokens: 64_000,
            supportsImages: false,
            contextWindow: { defaultLength: 200_000, supportedLengths: [200_000, 1_000_000] },
            reasoning: { defaultEffort: 'high' },
          },
        ],
        agents: [{ name: 'cli', models: ['hy3', 'ctx-model'] }],
        ...extra,
      },
    })
  }

  it('fetches /v3/config with the App-shaped UA and parses object context windows', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: { headers: Record<string, string> }) => {
      seen.push({ url: String(url), headers: init.headers })
      return fakeResponse(appEnvelope())
    }))
    const client = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => ({ version: '5.5.6', source: 'installed' }),
    })
    const models = await client.fetchModels(AI_CREDENTIAL)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://www.workbuddy.ai/v3/config')
    expect(seen[0]!.headers['User-Agent']).toBe('WorkBuddyAI/5.5.6')
    expect(seen[0]!.headers['X-Product']).toBe('SaaS')
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('ctx-model')?.contextWindow).toBe(200_000)
    expect(byId.get('ctx-model')?.maxInputTokens).toBe(1_000_000)
    expect(byId.get('ctx-model')?.supportedContextWindows).toEqual([200_000, 1_000_000])
    // No promotions in the document: rows pass through untouched.
    expect(byId.get('hy3')?.promotions).toEqual([])
    expect(byId.get('hy3')?.billing).toEqual({ free: false })
  })

  it('degrades to the CLI UA when version resolution fails', async () => {
    const seen: { headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { headers: Record<string, string> }) => {
      seen.push({ headers: init.headers })
      return fakeResponse(appEnvelope())
    }))
    const client = new WorkBuddyUpstreamClient({
      resolveAppVersion: async () => { throw new Error('no home') },
    })
    const models = await client.fetchModels(AI_CREDENTIAL)
    expect(seen[0]!.headers['User-Agent']).toBe('CLI/2.63.2 CodeBuddy/2.63.2')
    expect(models).toHaveLength(2)
  })

  it('applies an active factor-0 promotion as free with its badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(appEnvelope({
      modelPromotions: [{
        id: 'trial', enabled: true, modelIds: ['hy3'], priority: 200,
        schedule: { validFrom: '2026-01-01T00:00:00+08:00', validUntil: '2026-12-31T00:00:00+08:00' },
        discount: { displayMode: 'replace', factor: 0 },
        badge: { label: 'Free now' },
      }],
    }))))
    const models = await new WorkBuddyUpstreamClient().fetchModels(AI_CREDENTIAL)
    const raw = models.find(model => model.id === 'hy3')!
    // fetchModels returns the row as reported; the effective billing resolves
    // at catalog read time (the same layering the adapter serves).
    const hy3 = modelWithCurrentPromotion(raw)
    expect(hy3?.billing?.free).toBe(true)
    expect(hy3?.billing?.credits).toBe('x0.00')
    expect(hy3?.billing?.badges).toContain('Free now')
  })

  it('marks rateUnknown when every promotion on the row has expired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(appEnvelope({
      modelPromotions: [{
        id: 'trial', enabled: true, modelIds: ['hy3'], priority: 200,
        schedule: { validFrom: '2026-01-01T00:00:00+08:00', validUntil: '2026-02-01T00:00:00+08:00' },
        discount: { displayMode: 'replace', factor: 0 },
        badge: { label: 'Free now' },
      }],
    }))))
    const models = await new WorkBuddyUpstreamClient().fetchModels(AI_CREDENTIAL)
    const hy3 = models.find(model => model.id === 'hy3')!
    // Baked-in x0.00 is not trusted here (the test fabricates no credits), so
    // assert through the resolver: expired promo + factor-0 history ⇒ unknown.
    const withPromo = { ...hy3, billing: { ...hy3.billing, credits: 'x0.00', free: true } }
    const resolved = modelWithCurrentPromotion(withPromo, Date.parse('2026-09-15T00:00:00Z'))
    expect(resolved.billing).toEqual({ free: false, rateUnknown: true })
  })

  it('sends the international chat body with a leading system prompt', async () => {
    const seen: { body: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
      seen.push({ body: init.body })
      return { ok: false, status: 400, text: () => Promise.resolve('{"code":11102}') } as unknown as Response
    }))
    const result = await new WorkBuddyUpstreamClient().chatStream(
      AI_CREDENTIAL,
      JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(!result.ok && result.status).toBe(400)
    const sent = JSON.parse(seen[0]!.body) as { messages: { role: string }[] }
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
  })
})

describe('WorkBuddyUpstreamClient.probeEffort', () => {
  const ctrl = new AbortController()

  it('reports streamed acceptance on the first SSE event and hangs up', async () => {
    const seen: { url: string; body: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: { body: string }) => {
      seen.push({ url: String(url), body: init.body })
      return new Response('data: {"id":"x"}\n\n', { status: 200 })
    }))
    const attempt = await new WorkBuddyUpstreamClient().probeEffort(CREDENTIAL, 'm', 'low', ctrl.signal)
    expect(attempt).toEqual({ status: 200, streamed: true })
    const sent = JSON.parse(seen[0]!.body) as Record<string, unknown>
    expect(sent['reasoning_effort']).toBe('low')
    expect(sent['max_tokens']).toBe(1)
  })

  it('omits the effort field for the baseline and parses extError codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 11150, extError: { code: 'invalid_reasoning_effort' } }),
      { status: 400 },
    )))
    const attempt = await new WorkBuddyUpstreamClient().probeEffort(CREDENTIAL, 'm', undefined, ctrl.signal)
    expect(attempt).toEqual({ status: 400, streamed: false, errorCode: 'invalid_reasoning_effort', detail: 'invalid_reasoning_effort' })
  })

  it('uses the international body shape and ceiling on the global region', async () => {
    const seen: { body: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: { body: string }) => {
      seen.push({ body: init.body })
      return new Response('data: {"id":"x"}\n\n', { status: 200 })
    }))
    const ai = { ...CREDENTIAL, domain: 'www.workbuddy.ai' }
    const attempt = await new WorkBuddyUpstreamClient().probeEffort(ai, 'm', 'low', ctrl.signal)
    expect(attempt.status).toBe(200)
    const sent = JSON.parse(seen[0]!.body) as { messages: { role: string }[]; max_tokens: number }
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' })
    expect(sent.max_tokens).toBe(16)
  })

  it('counts transport failures as status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    const attempt = await new WorkBuddyUpstreamClient().probeEffort(CREDENTIAL, 'm', 'low', ctrl.signal)
    expect(attempt.status).toBe(0)
    expect(attempt.streamed).toBe(false)
  })
})
