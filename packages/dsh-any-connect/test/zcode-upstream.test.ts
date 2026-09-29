import crypto from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_ZCODE_MODELS,
  ZCodeUpstreamClient,
  decryptZCodeEncryptedKey,
  parseZCodeAuth,
  parseZCodePlanSelection,
  prepareAnthropicBody,
  selectZCodeAccountKey,
  type WorkBuddyCredential,
} from '../src/index.js'
import type { ZCodeClientSigner } from '../src/zcode-signer.js'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

describe('ZCode upstream and auth', () => {
  const dummyCredential: WorkBuddyCredential = {
    accessToken: 'test-id.test-secret',
    refreshToken: '',
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    domain: 'bigmodel.cn',
    uid: 'test-id',
    nickname: 'ZCode User',
    source: 'desktop',
  }

  describe('ZCode credential parsing and decryption', () => {
    it('decrypts encrypted key with machine fallback secret', () => {
      const fallbackSecret = `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`
      const aesKey = crypto.createHash('sha256').update(fallbackSecret).digest()
      const plainKey = '57271768622479063.secretkey123456'

      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv)
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plainKey, 'utf8')), cipher.final()])
      const tag = cipher.getAuthTag()

      const encStr = `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
      expect(decryptZCodeEncryptedKey(encStr)).toBe(plainKey)

      const credentialsDoc = JSON.stringify({
        'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': encStr,
      })
      const parsed = parseZCodeAuth(credentialsDoc)
      expect(parsed).toBeDefined()
      expect(parsed?.accessToken).toBe(plainKey)
      expect(parsed?.uid).toBe('57271768622479063')
      expect(parsed?.domain).toBe('bigmodel.cn')
    })

    it('decrypts encrypted key created on Windows when reading from WSL mount path', () => {
      const winSecret = 'zcode-credential-fallback:win32:C:\\Users\\alice:alice'
      const aesKey = crypto.createHash('sha256').update(winSecret).digest()
      const plainKey = '57271768622479063.windowskey123456'

      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv)
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plainKey, 'utf8')), cipher.final()])
      const tag = cipher.getAuthTag()

      const encStr = `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`

      // Decrypt with WSL path
      const decrypted = decryptZCodeEncryptedKey(encStr, { desktopPath: '/mnt/c/Users/alice/.zcode/v2/credentials.json' })
      expect(decrypted).toBe(plainKey)

      // parseZCodeAuth with desktopPath
      const credentialsDoc = JSON.stringify({
        'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': encStr,
      })
      const parsed = parseZCodeAuth(credentialsDoc, '/mnt/c/Users/alice/.zcode/v2/credentials.json')
      expect(parsed?.accessToken).toBe(plainKey)
    })

it('prefers the account key the client selected, not document order', async () => {
      // 真实安装会同时存在 team 与 individual 两把 key（本机实测如此）。
      // 历史实现取"第一个含 coding-plan 的条目"，于是选到哪把取决于对象
      // 插入顺序——这里把 team 放在前面，断言仍选中 individual。
      const doc = JSON.stringify({
        'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:57271768622479063:api-key': 'team-id.team-secret',
        'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'ind-id.ind-secret',
      })
      const selection = { family: 'bigmodel', plan: 'individual-coding-plan' } as const
      const entries = Object.entries(JSON.parse(doc) as Record<string, string>)
      const picked = selectZCodeAccountKey(entries, selection)
      expect(picked?.value).toBe('ind-id.ind-secret')
      expect(picked?.uid).toBe('57271768622479063')
      // 无选择信息时保留历史行为（首个条目），保证老文件仍可用。
      expect(selectZCodeAccountKey(entries)?.value).toBe('team-id.team-secret')
      // 选择指向不存在的条目时同样回落到首个条目。
      expect(selectZCodeAccountKey(entries, { family: 'zai', plan: 'start-plan' })?.value).toBe('team-id.team-secret')
    })

    it('reads the plan selection and the account JWT from the credentials document', async () => {
      const parsed = parseZCodePlanSelection(JSON.stringify({
        providerFamilyDomain: 'bigmodel',
        providerFamilyConnectionSelections: {
          bigmodel: { kind: 'start-plan' },
          zai: { kind: 'individual-coding-plan' },
        },
      }))
      expect(parsed).toEqual({ family: 'bigmodel', plan: 'start-plan' })
      // 无 family 字段时唯一选择仍可判定；两份选择且无 family 时取 bigmodel。
      expect(parseZCodePlanSelection(JSON.stringify({
        providerFamilyConnectionSelections: { zai: { kind: 'team-coding-plan' } },
      }))).toEqual({ family: 'zai', plan: 'team-coding-plan' })
      expect(parseZCodePlanSelection('not json')).toBeUndefined()
      expect(parseZCodePlanSelection(JSON.stringify({ providerFamilyConnectionSelections: {} }))).toBeUndefined()

      const plainKey = '57271768622479063.secretkey123456'
      const aesKey = crypto.createHash('sha256').update(
        `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${os.userInfo().username}`,
      ).digest()
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv)
      const ciphertext = Buffer.concat([cipher.update(Buffer.from('header.payload.sig', 'utf8')), cipher.final()])
      const tag = cipher.getAuthTag()
      const jwtEnc = `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`

      const parsedCredential = parseZCodeAuth(JSON.stringify({
        'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': plainKey,
        'zcodejwttoken': jwtEnc,
      }))
      expect(parsedCredential?.accessToken).toBe(plainKey)
      expect(parsedCredential?.zcodeJwtToken).toBe('header.payload.sig')
    })

it('attributes the plan to the client selection, not to the fallback key', async () => {
      // 账号计划（start-plan）在凭据里没有对应的 api-key 条目：accessToken
      // 只能回落到别的账号的 key。这只说明"哪把 key 能用"，不说明账号属于
      // 哪个计划——把回落的 key 当成计划会让额度读到别的账号上去。
      const settingDir = await mkdtemp(join(tmpdir(), 'zc-selection-'))
      CLEANUP.push(() => rm(settingDir, { recursive: true, force: true }))
      await writeFile(join(settingDir, 'setting.json'), JSON.stringify({
        providerFamilyDomain: 'bigmodel',
        providerFamilyConnectionSelections: { bigmodel: { kind: 'start-plan' } },
      }))
      const credPath = join(settingDir, 'credentials.json')
      await writeFile(credPath, JSON.stringify({
        'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:57271768622479063:api-key': 'team-id.team-secret',
      }))

      const parsed = parseZCodeAuth(await readFile(credPath, 'utf8'), credPath)
      expect(parsed?.zcodePlan).toBe('start-plan')
      // 凭据里只有 team 的 key，仍按选择了读到它（请求要靠它签名）。
      expect(parsed?.accessToken).toBe('team-id.team-secret')

      // 反过来：客户端选 individual 时，计划必须是 individual，不是文件里
      // 排在前面的那个。
      await writeFile(join(settingDir, 'setting.json'), JSON.stringify({
        providerFamilyDomain: 'bigmodel',
        providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } },
      }))
      const individual = parseZCodeAuth(await readFile(credPath, 'utf8'), credPath)
      expect(individual?.zcodePlan).toBe('individual-coding-plan')
    })

    it('reports the upstream plan name instead of a hardcoded one', async () => {
      const mockFetch = vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [
          { productName: 'ZCode Trust Build', status: 'VALID' },
          { productName: 'GLM Coding Pro', status: 'EXPIRED' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      vi.stubGlobal('fetch', mockFetch)
      const client = new ZCodeUpstreamClient()
      const credits = await client.fetchCredits(dummyCredential)
      // 名称随活动变（本机实测为 "ZCode Trust Build"），界面标签必须回填
      // 这个真实值，不能写死 "Coding Plan"。
      expect(credits.accounts[0]?.planName).toBe('ZCode Trust Build')
      expect(credits.accounts[1]?.planName).toBe('GLM Coding Pro')
      vi.unstubAllGlobals()
    })

    it('decrypts with explicit platform options', () => {
      const customSecret = 'zcode-credential-fallback:darwin:/Users/bob:bob'
      const aesKey = crypto.createHash('sha256').update(customSecret).digest()
      const plainKey = '57271768622479063.customplatformkey'

      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv)
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plainKey, 'utf8')), cipher.final()])
      const tag = cipher.getAuthTag()

      const encStr = `enc:v1:${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
      const decrypted = decryptZCodeEncryptedKey(encStr, { platform: 'darwin', homedir: '/Users/bob', username: 'bob' })
      expect(decrypted).toBe(plainKey)
    })
  })

  describe('ZCodeUpstreamClient', () => {
    it('returns fallback models', async () => {
      // stub fetch:此用例断言的是 fallback 常量的形状,任何分支都返回
      // this.models——不打 stub 会直连 open.bigmodel.cn(假 bearer),CI 断网
      // 下挂满 30s deadline,有网环境产生无谓真实出口流量。
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
      const client = new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_MODELS })
      const models = await client.fetchModels(dummyCredential)
      expect(models.map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
      expect(models.find(m => m.id === 'glm-5.3')?.contextWindow).toBe(1000000)
      expect(models.find(m => m.id === 'glm-5.3')?.maxTokens).toBe(128000)
      expect(models.find(m => m.id === 'glm-5.3')?.billing?.badges).toContain('150% 额度')
      expect(models.find(m => m.id === 'glm-5.3-flash')?.contextWindow).toBe(1000000)
      expect(models.find(m => m.id === 'glm-5.3-flash')?.maxTokens).toBe(128000)
      expect(models.find(m => m.id === 'glm-5.3-flash')?.billing?.badges).toContain('夜间免费')
      vi.unstubAllGlobals()
    })

    it('refreshes token as a no-op returning same accessToken', async () => {
      const client = new ZCodeUpstreamClient()
      const outcome = await client.refreshToken(dummyCredential)
      expect(outcome.accessToken).toBe(dummyCredential.accessToken)
    })

    it('fetches subscription credits and formats active accounts', async () => {
      const mockFetch = vi.fn(async (url: string) => {
        expect(url).toBe('https://bigmodel.cn/api/biz/subscription/list')
        return new Response(JSON.stringify({
          code: 200,
          data: [
            { productName: 'GLM Coding Pro', status: 'VALID' },
            { productName: 'Trial Plan', status: 'EXPIRED' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      })

      vi.stubGlobal('fetch', mockFetch)
      const client = new ZCodeUpstreamClient()
      const credits = await client.fetchCredits(dummyCredential)

      expect(credits.total).toBe(1)
      expect(credits.accounts).toHaveLength(2)
      expect(credits.accounts[0]?.packageName).toBe('GLM Coding Pro (有效)')
      expect(credits.accounts[0]?.remain).toBe(1)
      expect(credits.accounts[1]?.packageName).toBe('Trial Plan (EXPIRED)')
      expect(credits.accounts[1]?.remain).toBe(0)

      vi.unstubAllGlobals()
    })

    it('streams chat completions with ZCode signed headers', async () => {
      const mockSigner = {
        buildHeaders: vi.fn(async () => ({
          'Authorization': 'Bearer test-id.test-secret',
          'X-App-Id': 'zcode',
          'X-Client-Sig': 'mocksig',
        })),
      } as unknown as ZCodeClientSigner

      const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
        const headers = init?.headers as Record<string, string>
        expect(headers['X-App-Id']).toBe('zcode')
        expect(headers['X-Client-Sig']).toBe('mocksig')
        expect(headers['Content-Type']).toBe('application/json')
        expect(headers['Accept']).toBe('text/event-stream')
        expect(headers['anthropic-version']).toBe('2023-06-01')

        const body = JSON.parse(init?.body as string)
        expect(body.stream).toBe(true)
        expect(body.model).toBe('glm-5.3')
        expect(body.max_tokens).toBe(8192)

        return new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      })

      vi.stubGlobal('fetch', mockFetch)
      const client = new ZCodeUpstreamClient({ signer: mockSigner })
      const result = await client.chatStream(
        dummyCredential,
        JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'ping' }] }),
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(await result.response.text()).toContain('pong')
      }

      vi.unstubAllGlobals()
    })

    it('classifies upstream error when chat completions fails', async () => {
      const mockSigner = {
        buildHeaders: vi.fn(async () => ({})),
      } as unknown as ZCodeClientSigner

      const mockFetch = vi.fn(async () => {
        return new Response('{"error":"quota exceeded, please upgrade"}', {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        })
      })

      vi.stubGlobal('fetch', mockFetch)
      const client = new ZCodeUpstreamClient({ signer: mockSigner })
      const result = await client.chatStream(dummyCredential, '{}')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(402)
        expect(result.kind).toBe('hard_credit')
      }

      vi.unstubAllGlobals()
    })
  })

  describe('prepareAnthropicBody', () => {
    it('forces stream: true and provides default max_tokens', () => {
      const input = JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'hello' }],
      })
      const output = JSON.parse(prepareAnthropicBody(input))
      expect(output.stream).toBe(true)
      expect(output.max_tokens).toBe(8192)
      expect(output.model).toBe('glm-5.3-flash')
      expect(output.messages).toEqual([{ role: 'user', content: 'hello' }])
    })

    it('extracts system and developer messages into top-level system parameter', () => {
      const input = JSON.stringify({
        model: 'glm-5.3',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'question' },
        ],
      })
      const output = JSON.parse(prepareAnthropicBody(input))
      expect(output.system).toBe('You are a helpful assistant.')
      expect(output.messages).toEqual([{ role: 'user', content: 'question' }])
    })

    it('converts OpenAI function tools into Anthropic input_schema tools', () => {
      const input = JSON.stringify({
        model: 'glm-5.3',
        messages: [{ role: 'user', content: 'weather' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather lookup',
              parameters: { type: 'object', properties: { loc: { type: 'string' } } },
            },
          },
        ],
      })
      const output = JSON.parse(prepareAnthropicBody(input))
      expect(output.tools).toEqual([
        {
          name: 'get_weather',
          description: 'weather lookup',
          input_schema: { type: 'object', properties: { loc: { type: 'string' } } },
        },
      ])
    })
    it('merges into an existing top-level system string instead of dropping the messages', () => {
      // 回归:此前顶层 system 已是 string 时,system/developer 消息被整体
      // 丢弃(留在 messages 里会被 Anthropic 端点拒绝)。
      const input = JSON.stringify({
        model: 'glm-5.3',
        system: 'Be concise.',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'question' },
        ],
      })
      const output = JSON.parse(prepareAnthropicBody(input))
      expect(output.system).toBe('Be concise.\n\nYou are a helpful assistant.')
      expect(output.messages).toEqual([{ role: 'user', content: 'question' }])
    })

    it('appends text blocks to an existing system blocks array without overwriting it', () => {
      // 回归:此前 blocks 数组形态的顶层 system 被 join 字符串整体覆盖,
      // 原 system 内容静默丢失。
      const input = JSON.stringify({
        model: 'glm-5.3',
        system: [{ type: 'text', text: 'Be concise.' }],
        messages: [
          { role: 'developer', content: 'Prefer TypeScript.' },
          { role: 'user', content: 'question' },
        ],
      })
      const output = JSON.parse(prepareAnthropicBody(input))
      expect(output.system).toEqual([
        { type: 'text', text: 'Be concise.' },
        { type: 'text', text: 'Prefer TypeScript.' },
      ])
      expect(output.messages).toEqual([{ role: 'user', content: 'question' }])
    })

    it('leaves a malformed top-level system untouched instead of overwriting it', () => {
      // 畸形形态(非 string/数组)不归本转换器管:保持原样连同 system 消息,
      // 让上游校验给出明确错误,而不是猜测性地覆盖。
      const input = JSON.stringify({
        model: 'glm-5.3',
        system: 42,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'question' },
        ],
      })
      const output = JSON.parse(prepareAnthropicBody(input))
      expect(output.system).toBe(42)
      expect(output.messages).toHaveLength(2)
    })  })
})

