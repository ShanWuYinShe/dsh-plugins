import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.js'
import { FALLBACK_ZCODE_MODELS } from '../src/catalog.js'
import { createWorkBuddyShim } from '../src/shim.js'
import { ZcodeCredentialStore, maskApiKey, zcodeOwnAuthPath } from '../src/zcode-auth.js'
import { ZcodeUpstreamClient } from '../src/zcode-upstream.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ZcodeCredentialStore', () => {
  it('resolves the key with config > env > file precedence, skipping blanks', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    const ownPath = join(root, '.zcode-auth.json')
    const store = new ZcodeCredentialStore({ ownPath })
    expect(await store.current()).toBeUndefined()

    await writeFile(ownPath, JSON.stringify({ version: 1, apiKey: ' file-key ' }))
    expect(await store.current()).toEqual({ accessToken: 'file-key', source: 'file' })

    vi.stubEnv('ZCODE_API_KEY', '  env-key  ')
    expect(await store.current()).toEqual({ accessToken: 'env-key', source: 'env' })

    store.setConfiguredKey('config-key')
    expect(await store.current()).toEqual({ accessToken: 'config-key', source: 'config' })

    // 空白值视为未配置：清空设置卡字段即回落到 env，而不是锁死在空字符串上。
    store.setConfiguredKey('   ')
    expect(await store.current()).toEqual({ accessToken: 'env-key', source: 'env' })
  })

  it('reads status with a masked-key nickname and logout removes only the own file', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    const ownPath = join(root, '.zcode-auth.json')
    const store = new ZcodeCredentialStore({ ownPath })
    expect(await store.status()).toEqual({ state: 'signed-out' })

    await writeFile(ownPath, JSON.stringify({ version: 1, apiKey: 'abcd1234efgh5678' }))
    const status = await store.status()
    expect(status.state).toBe('signed-in')
    expect(status.nickname).toBe(maskApiKey('abcd1234efgh5678'))

    await store.logout()
    await expect(readFile(ownPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.current()).toBeUndefined()
  })

  it('rejects malformed key files instead of serving garbage; status degrades to a reason', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    const ownPath = join(root, '.zcode-auth.json')
    await writeFile(ownPath, 'not json at all')
    const store = new ZcodeCredentialStore({ ownPath })
    await expect(store.resolve()).rejects.toThrow('not valid JSON')
    // 卡片走 status：坏文件是可诊断的「未配置 + 原因」，不该 500 整张卡。
    const degraded = await store.status()
    expect(degraded.state).toBe('signed-out')
    expect(degraded.reason).toContain('not valid JSON')

    await writeFile(ownPath, JSON.stringify({ apiKey: 'no-version' }))
    await expect(store.resolve()).rejects.toThrow('unrecognized shape')
  })

  it('masks keys by keeping the first and last four characters', () => {
    expect(maskApiKey('abcd1234efgh5678')).toBe('abcd••••5678')
    expect(maskApiKey('short')).toBe('••••')
  })
})

describe('ZcodeUpstreamClient.forwardMessages', () => {
  it('posts the body verbatim with the coding-plan auth headers', async () => {
    const fetchMock = vi.fn(async () => new Response('data: ok\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ZcodeUpstreamClient()
    const result = await client.forwardMessages(
      { accessToken: 'plan-key', source: 'config' },
      '{"model":"GLM-5.3"}',
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/anthropic/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'plan-key',
          'anthropic-version': '2023-06-01',
        },
        body: '{"model":"GLM-5.3"}',
      }),
    )
  })

  it('relays upstream failures raw (bigmodel error shape, no reclassification)', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"令牌已过期或验证不正确","type":"401"}}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ZcodeUpstreamClient()
    const result = await client.forwardMessages(
      { accessToken: 'bad-key', source: 'env' },
      '{}',
      new AbortController().signal,
    )
    expect(result).toMatchObject({ ok: false, status: 401, contentType: 'application/json' })
    expect(JSON.parse(result.ok === false ? result.body : '')).toMatchObject({ error: { type: '401' } })
  })
})

describe('zcode shim route', () => {
  function makeShim(store: ZcodeCredentialStore, forward: ReturnType<typeof vi.fn>) {
    return createWorkBuddyShim({
      kind: 'zcode',
      store,
      client: { forwardMessages: forward as unknown as ZcodeUpstreamClient['forwardMessages'] },
      catalog: new WorkBuddyCatalog(FALLBACK_ZCODE_MODELS),
    })
  }

  it('relays /v1/messages with the store key and authenticates via x-api-key or bearer', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-shim-'))
    const forward = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      response: new Response('event: message_stop\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    }))
    const shim = makeShim(new ZcodeCredentialStore({ configuredKey: 'plan-key' }), forward)
    await shim.ready
    try {
      // Anthropic SDK 的拼写：x-api-key。
      const viaApiKey = await fetch(`${shim.baseUrl()}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': shim.token() },
        body: JSON.stringify({ model: 'GLM-5.3', max_tokens: 16, messages: [] }),
      })
      expect(viaApiKey.status).toBe(200)
      expect(await viaApiKey.text()).toContain('message_stop')
      // OpenAI 侧同款的 Bearer 拼写同样放行（同一共享密钥）。
      const viaBearer = await fetch(`${shim.baseUrl()}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
        body: JSON.stringify({ model: 'GLM-5.3' }),
      })
      expect(viaBearer.status).toBe(200)
      // 上游收到的正是原始请求体 + plan key（而非共享密钥）。
      expect(forward).toHaveBeenCalledTimes(2)
      const [forwardedCredential, rawBody, signal] = forward.mock.calls[0] as unknown as [{ accessToken: string }, string, AbortSignal]
      expect(JSON.parse(rawBody)).toMatchObject({ model: 'GLM-5.3' })
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(forwardedCredential).toEqual({ accessToken: 'plan-key', source: 'config' })
      // WorkBuddy 形状的 /v1/chat/completions 在 zcode shim 上不存在。
      const wrongRoute = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${shim.token()}` },
        body: '{}',
      })
      expect(wrongRoute.status).toBe(404)
    } finally {
      await shim.close()
    }
  })

  it('answers 401 (anthropic-shaped) when no key is configured and relays upstream errors raw', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-shim-'))
    const forward = vi.fn(async () => ({
      ok: false as const,
      status: 401,
      contentType: 'application/json',
      body: '{"error":{"message":"令牌已过期或验证不正确","type":"401"}}',
    }))
    const shim = makeShim(new ZcodeCredentialStore({ ownPath: join(root, 'absent.json') }), forward)
    await shim.ready
    try {
      const unauthenticated = await fetch(`${shim.baseUrl()}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': shim.token() },
        body: '{}',
      })
      expect(unauthenticated.status).toBe(401)
      const payload = await unauthenticated.json() as { type: string; error: { type: string } }
      expect(payload.type).toBe('error')
      expect(payload.error.type).toBe('authentication_error')
      expect(forward).not.toHaveBeenCalled()

      const store = new ZcodeCredentialStore({ configuredKey: 'wrong-key' })
      const failing = makeShim(store, forward)
      await failing.ready
      try {
        const relayed = await fetch(`${failing.baseUrl()}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': failing.token() },
          body: '{}',
        })
        expect(relayed.status).toBe(401)
        expect(await relayed.json()).toMatchObject({ error: { type: '401' } })
      } finally {
        await failing.close()
      }
    } finally {
      await shim.close()
    }
  })

  it('serves the GLM roster on /v1/models owned by zcode', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-shim-'))
    const shim = makeShim(new ZcodeCredentialStore({ configuredKey: 'k' }), vi.fn())
    await shim.ready
    try {
      const models = await fetch(`${shim.baseUrl()}/v1/models`, {
        headers: { authorization: `Bearer ${shim.token()}` },
      })
      const payload = await models.json() as { data: Array<{ id: string; owned_by: string }> }
      expect(payload.data.map(row => row.id)).toContain('GLM-5.3')
      expect(payload.data.every(row => row.owned_by === 'zcode')).toBe(true)
    } finally {
      await shim.close()
    }
  })
})

describe('zcode own path', () => {
  it('lives under $DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '/tmp/dsh-any-connect-zcode-home-test')
    expect(zcodeOwnAuthPath()).toBe(join('/tmp/dsh-any-connect-zcode-home-test', '.zcode-auth.json'))
  })
})
