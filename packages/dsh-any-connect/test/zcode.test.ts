import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { homedir, platform as osPlatform, userInfo } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.js'
import { FALLBACK_ZCODE_MODELS } from '../src/catalog.js'
import { createWorkBuddyShim } from '../src/shim.js'
import type { ZcodeCredential } from '../src/zcode-auth.js'
import { ZcodeCredentialStore, maskApiKey, zcodeOwnAuthPath } from '../src/zcode-auth.js'
import { ZcodeUpstreamClient } from '../src/zcode-upstream.js'
import { ZcodeOffpeakCredentialStore } from '../src/zcode-offpeak.js'
import { readZcodeClientCredentials } from '../src/zcode-credentials.js'

/** 测试用的隔离 zcode 凭据路径（不存在 → 跟随 zcode 来源恒空）。 */
function absentZcodeCredentials(root: string): string {
  return join(root, 'no-such-zcode-credentials.json')
}

/** 按生产算法加密一份合成 zcode 凭据文件（验证解密实现本身）。 */
async function writeSyntheticZcodeCredentials(root: string, fields: Record<string, string>): Promise<string> {
  const path = join(root, 'zcode-credentials.json')
  const secret = `zcode-credential-fallback:${osPlatform()}:${homedir()}:${userInfo().username}`
  const key = createHash('sha256').update(secret, 'utf8').digest()
  const encrypted: Record<string, string> = {}
  for (const [field, value] of Object.entries(fields)) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    encrypted[field] = `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
  }
  await writeFile(path, JSON.stringify(encrypted))
  return path
}

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ZcodeCredentialStore', () => {
  it('resolves the key with config > env > zcode-follow > file precedence, skipping blanks', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    const ownPath = join(root, '.zcode-auth.json')
    const absentZcode = absentZcodeCredentials(root)
    const store = new ZcodeCredentialStore({ ownPath, zcodeCredentialsPath: absentZcode })
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

    // 跟随 zcode 的来源优先于自有文件（解密用另一份 store 指向合成凭据；
    // env 先清空，让优先级链走到 zcode 段）。
    vi.stubEnv('ZCODE_API_KEY', '')
    const zcodePath = await writeSyntheticZcodeCredentials(root, {
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:acct-1:api-key': 'zcodeid.zcodesecret',
      'zcodejwttoken': 'jwt-value',
    })
    const followStore = new ZcodeCredentialStore({ ownPath, zcodeCredentialsPath: zcodePath })
    expect(await followStore.current()).toEqual({ accessToken: 'zcodeid.zcodesecret', source: 'zcode' })
  })

  it('reads status with a masked-key nickname and logout removes only the own file', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    const ownPath = join(root, '.zcode-auth.json')
    const store = new ZcodeCredentialStore({ ownPath, zcodeCredentialsPath: absentZcodeCredentials(root) })
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
    const store = new ZcodeCredentialStore({ ownPath, zcodeCredentialsPath: absentZcodeCredentials(root) })
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

describe('readZcodeClientCredentials (decrypt)', () => {
  it('decrypts the plan key, JWT, and OAuth token from a synthetic store', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    const path = await writeSyntheticZcodeCredentials(root, {
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:acct-42:api-key': 'planid.plans',
      'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:acct-42:api-key': 'teamid.teamsecret',
      'zcodejwttoken': 'jwt-token-value',
      'oauth:bigmodel:access_token': 'oauth-token-value',
      'unrelated': 'plain value',
    })
    const credentials = await readZcodeClientCredentials({ path })
    expect(credentials).toEqual({
      planApiKey: 'planid.plans',
      planAccountId: 'acct-42',
      jwt: 'jwt-token-value',
      oauthAccessToken: 'oauth-token-value',
    })
  })

  it('returns undefined when the store is absent and throws when the key is wrong', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    expect(await readZcodeClientCredentials({ path: absentZcodeCredentials(root) })).toBeUndefined()

    // 密文被篡改（tag 不匹配）→ 抛错而不是吞成未配置。
    const path = join(root, 'zcode-credentials.json')
    await writeFile(path, JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:a:api-key': 'enc:v1:AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA',
    }))
    await expect(readZcodeClientCredentials({ path })).rejects.toThrow()
  })
})

describe('ZcodeOffpeakCredentialStore', () => {
  it('is signed in only when the plan key and JWT both exist, following the zcode store', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    const absent = absentZcodeCredentials(root)
    expect(await new ZcodeOffpeakCredentialStore({ zcodeCredentialsPath: absent }).current()).toBeUndefined()
    expect(await new ZcodeOffpeakCredentialStore({ zcodeCredentialsPath: absent }).status()).toMatchObject({ state: 'signed-out' })

    // 只有 key 没有 JWT（旧版 zcode 凭据）同样不可用。
    const keyOnly = await writeSyntheticZcodeCredentials(root, {
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:acct-1:api-key': 'planid.secret',
    })
    const keyOnlyStore = new ZcodeOffpeakCredentialStore({ zcodeCredentialsPath: keyOnly })
    expect(await keyOnlyStore.current()).toBeUndefined()

    // key + JWT 齐备 → signed-in（复用同一合成文件路径，覆写为完整字段集）。
    const full = await writeSyntheticZcodeCredentials(root, {
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:acct-1:api-key': 'planid.secret',
      'zcodejwttoken': 'jwt-value',
    })
    const fullStore = new ZcodeOffpeakCredentialStore({ zcodeCredentialsPath: full })
    expect(await fullStore.current()).toEqual({ jwt: 'jwt-value', planApiKey: 'planid.secret' })
    expect(await fullStore.status()).toMatchObject({ state: 'signed-in' })
  })
})

describe('ZcodeUpstreamClient.forwardMessages', () => {
  it('posts the body verbatim with the full zcode client identity and dual auth headers', async () => {
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
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, {
      method: string
      headers: Record<string, string>
      body: string
    }]
    // 请求体原样透传；鉴权是 zcode 形状的双头同值。
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"model":"GLM-5.3"}')
    expect(init.headers['x-api-key']).toBe('plan-key')
    expect(init.headers['authorization']).toBe('Bearer plan-key')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    // zcode 客户端身份头（权益结算的识别面）。
    expect(init.headers['user-agent']).toMatch(/^ZCode\//)
    expect(init.headers['x-zcode-app-version']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(init.headers['http-referer']).toBe('https://zcode.z.ai')
    expect(init.headers['x-title']).toBe('Z Code@electron')
    expect(init.headers['x-zcode-agent']).toBe('glm')
    // attribution 头每请求生成。
    expect(init.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(init.headers['x-session-id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(init.headers['x-zcode-session-type']).toBe('main')
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
  function makeShim(credential: ZcodeCredential | undefined, forward: ReturnType<typeof vi.fn>) {
    return createWorkBuddyShim({
      kind: 'zcode',
      resolveCredential: async () => {
        if (credential === undefined) throw new Error('no GLM Coding Plan API key configured')
        return credential
      },
      forwardMessages: (value, rawBody, signal) => forward(value as ZcodeCredential, rawBody, signal),
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
    const shim = makeShim({ accessToken: 'plan-key', source: 'config' }, forward)
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
    const shim = makeShim(undefined, forward)
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

      const failing = makeShim({ accessToken: 'wrong-key', source: 'config' }, forward)
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
    const shim = makeShim({ accessToken: 'k', source: 'config' }, vi.fn())
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
