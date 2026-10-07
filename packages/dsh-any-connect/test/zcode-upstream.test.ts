import crypto from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_APP_VERSION,
  FALLBACK_ZCODE_MODELS,
  FALLBACK_ZCODE_START_PLAN_MODELS,
  ZCodeUpstreamClient,
  decryptZCodeEncryptedKey,
  parseZCodeAuth,
  parseZCodePlanSelection,
  prepareAnthropicBody,
  prepareStartPlanBody,
  selectZCodeAccountKey,
  ZCODE_CLIENT_IDENTITY,
  ZCODE_CLIENT_PREFIX,
  type WorkBuddyCredential,
} from '../src/index.js'
import type { ZCodeClientSigner } from '../src/zcode-signer.js'
import { codingPlanWhitelistFromConfig, filterByCodingPlanWhitelist, readZcodeCodingPlanWhitelist } from '../src/zcode-builtin-catalog.js'

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

  /** 注入的白名单构造器：与生产默认实现（读本机客户端文件）隔离，测试不依赖真实安装。 */
  const whitelistOf = (ids: readonly string[]) => () => new Set(ids.map(id => id.toLowerCase()))

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

    it('reads the plan selection from the credentials document', async () => {
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
        // 凭据里另有一份账号 JWT：按 2026-09-30 口径解密携带（Start Plan 专属
        // 通道的鉴权材料），是否使用由生效计划决定——这里与客户端选择无关，
        // 只要文档里有就带上。
        'zcodejwttoken': jwtEnc,
      }))
      expect(parsedCredential?.accessToken).toBe(plainKey)
      expect(parsedCredential?.zcodeJwtToken).toBe('header.payload.sig')
      // 设备号同步解析（专属通道硬要求 X-Device-Mid）。
      expect(parsedCredential?.zcodeDeviceMid).toEqual(expect.any(String))
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
      // 账号计划在凭据里没有自己的 key：请求回落到账户上的 coding-plan key。
      // 这条回落是本包"按普通 ZCode 使用 Start Plan"的基础。
      expect(parsed?.accessToken).toBe('team-id.team-secret')
      expect(parsed?.zcodePlan).toBe('start-plan')

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
      const client = new ZCodeUpstreamClient({
        models: FALLBACK_ZCODE_MODELS,
        resolveCodingPlanWhitelist: whitelistOf(['glm-5.3', 'glm-5.3-flash']),
      })
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

    /**
     * 上游 paas 目录只作存在性参考，产品面由客户端内置目录的白名单圈定；本地
     * 目录当元数据表。此前三个分支全返回 this.models，上游 data 只被用来判断
     * 非空后丢弃——每小时刷新的唯一效果是"证明凭据还活着"。
     */
    it('白名单内的上游新 id 采用保守默认参数', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [{ id: 'brand-new-model' }],
      }), { status: 200 })))
      const client = new ZCodeUpstreamClient({
        models: FALLBACK_ZCODE_MODELS,
        resolveCodingPlanWhitelist: whitelistOf(['glm-5.3', 'glm-5.3-flash', 'brand-new-model']),
      })
      const models = await client.fetchModels(dummyCredential)
      // 新 id 出现（官方收录 + 上游在列，不再被编译期常量吞掉）
      expect(models.map(m => m.id)).toContain('brand-new-model')
      // 保守默认：不虚报窗口/输出，不带促销徽标
      const fresh = models.find(m => m.id === 'brand-new-model')
      expect(fresh?.contextWindow).toBe(200000)
      expect(fresh?.maxTokens).toBe(32000)
      expect(fresh?.supportsImages).toBe(false)
      expect(fresh?.billing?.credits).toBe('x1.00')
      expect(fresh?.billing?.badges).toBeUndefined()
      vi.unstubAllGlobals()
    })

    it('官方白名单外的上游 id 不展示（端点放行 ≠ 订阅覆盖）', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [{ id: 'brand-new-model' }, { id: 'glm-5.3' }],
      }), { status: 200 })))
      const client = new ZCodeUpstreamClient({
        models: FALLBACK_ZCODE_MODELS,
        resolveCodingPlanWhitelist: whitelistOf(['glm-5.3', 'glm-5.3-flash']),
      })
      const models = await client.fetchModels(dummyCredential)
      // 白名单外的开放平台模型被拦下；白名单内的照常出现——包括上游未列出、
      // 但本地已验证且仍在白名单内的 glm-5.3-flash（并集保留行）。
      expect(models.map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
      vi.unstubAllGlobals()
    })

    it('上游列出的本地已收录 id 沿用其已验证参数与费率', async () => {
      // 断言 join 的保真度：本地行带着 128K/自定义费率/徽章，上游只给 id。
      // 这里也断言**顺序与数量**跟上游一致，否则旧实现（无条件返回本地整表）
      // 会碰巧通过。
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [{ id: 'glm-5.3-flash' }, { id: 'glm-5.3' }],
      }), { status: 200 })))
      const client = new ZCodeUpstreamClient({
        models: FALLBACK_ZCODE_MODELS,
        resolveCodingPlanWhitelist: whitelistOf(['glm-5.3-flash', 'glm-5.3']),
      })
      const models = await client.fetchModels(dummyCredential)
      // 上游顺序被保留（flash 在前），不是本地常量顺序。
      expect(models.map(m => m.id)).toEqual(['glm-5.3-flash', 'glm-5.3'])
      const glm53 = models.find(m => m.id === 'glm-5.3')
      // join 不能把 128K 与自定义费率弄丢
      expect(glm53?.contextWindow).toBe(1000000)
      expect(glm53?.maxTokens).toBe(128000)
      expect(glm53?.billing?.credits).toBe('x1.00')
      expect(glm53?.billing?.badges).toContain('150% 额度')
      const flash = models.find(m => m.id === 'glm-5.3-flash')
      expect(flash?.contextWindow).toBe(1000000)
      expect(flash?.maxTokens).toBe(128000)
      expect(flash?.billing?.credits).toBe('x0.06')
      expect(flash?.billing?.badges).toContain('夜间免费')
      vi.unstubAllGlobals()
    })

    it('保留本地已收录但上游未列出的模型（并集，不因上游只列一部分而消失）', async () => {
      // 上游目录可能只列一部分：本地收录且仍在白名单内的模型不因上游缺席而消失。
      // 用一个与编译期常量不同的本地目录，才能把"真的做了并集"与"直接返回常量"
      // 区分开——若沿用 FALLBACK_ZCODE_MODELS，旧实现（无条件 return this.models）
      // 会碰巧满足断言，用例就抓不到 bug。
      const local = [
        { id: 'local-kept', name: 'Local Kept', contextWindow: 1000000, maxTokens: 128000, supportsImages: true },
        { id: 'local-dropped-by-upstream', name: 'Local Only', contextWindow: 500000, maxTokens: 64000, supportsImages: false },
      ]
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [{ id: 'local-kept' }, { id: 'fresh-from-upstream' }],
      }), { status: 200 })))
      const models = await new ZCodeUpstreamClient({
        models: local,
        resolveCodingPlanWhitelist: whitelistOf(['local-kept', 'fresh-from-upstream', 'local-dropped-by-upstream']),
      }).fetchModels(dummyCredential)
      // 上游在前（沿用本地已验证参数）、本地补充在后，保序去重。
      expect(models.map(m => m.id)).toEqual(['local-kept', 'fresh-from-upstream', 'local-dropped-by-upstream'])
      // 上游列出的已收录 id 必须沿用本地参数（不能因 join 丢失）。
      expect(models.find(m => m.id === 'local-kept')?.contextWindow).toBe(1000000)
      expect(models.find(m => m.id === 'local-kept')?.maxTokens).toBe(128000)
      // 上游未列的本地模型必须保留其原始行。
      expect(models.find(m => m.id === 'local-dropped-by-upstream')?.contextWindow).toBe(500000)
      vi.unstubAllGlobals()
    })

    it('本地保留行的存废也由白名单定：白名单外的新 id 不出现', async () => {
      // 同样的上游响应，白名单不含 fresh-from-upstream：新 id 被拦下，两个本地行
      // 照常保留——本地保留行的存废由产品面白名单定，不由上游列表定。
      const local = [
        { id: 'local-kept', name: 'Local Kept', contextWindow: 1000000, maxTokens: 128000, supportsImages: true },
        { id: 'local-dropped-by-upstream', name: 'Local Only', contextWindow: 500000, maxTokens: 64000, supportsImages: false },
      ]
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [{ id: 'local-kept' }, { id: 'fresh-from-upstream' }],
      }), { status: 200 })))
      const models = await new ZCodeUpstreamClient({
        models: local,
        resolveCodingPlanWhitelist: whitelistOf(['local-kept', 'local-dropped-by-upstream']),
      }).fetchModels(dummyCredential)
      expect(models.map(m => m.id)).toEqual(['local-kept', 'local-dropped-by-upstream'])
      vi.unstubAllGlobals()
    })

    it('上游返回空/null/非数组时回退 this.models', async () => {
      for (const data of [[], null, 'nope', undefined]) {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 200, data }), { status: 200 })))
        const models = await new ZCodeUpstreamClient({
          models: FALLBACK_ZCODE_MODELS,
          resolveCodingPlanWhitelist: whitelistOf(['glm-5.3', 'glm-5.3-flash']),
        }).fetchModels(dummyCredential)
        expect(models.map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
      }
      vi.unstubAllGlobals()
    })

    it('上游请求失败（非 ok / 抛错）时回退 this.models', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
      expect((await new ZCodeUpstreamClient({
        models: FALLBACK_ZCODE_MODELS,
        resolveCodingPlanWhitelist: whitelistOf(['glm-5.3', 'glm-5.3-flash']),
      }).fetchModels(dummyCredential)).map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])

      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
      expect((await new ZCodeUpstreamClient({
        models: FALLBACK_ZCODE_MODELS,
        resolveCodingPlanWhitelist: whitelistOf(['glm-5.3', 'glm-5.3-flash']),
      }).fetchModels(dummyCredential)).map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
      vi.unstubAllGlobals()
    })

    it('上游返回的 id 大小写归一、空 id 忽略、重复不产生重复行', async () => {
      // 本地收录 GLM-5.3（大写 id），上游同时给大小写两种写法与一个空 id：
      // 归一后只应产生一行，且沿用本地参数。旧实现无条件返回本地整表，
      // 会少掉 new-dup 之外的行，抓得到 bug。
      const local = [
        { id: 'GLM-5.3', name: 'GLM-5.3', contextWindow: 1000000, maxTokens: 128000, supportsImages: true },
        { id: 'local-extra', name: 'Local Extra', contextWindow: 300000, maxTokens: 32000, supportsImages: false },
      ]
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [{ id: 'GLM-5.3' }, { id: 'glm-5.3' }, { id: '  ' }, { id: 'fresh-new' }],
      }), { status: 200 })))
      const models = await new ZCodeUpstreamClient({
        models: local,
        resolveCodingPlanWhitelist: whitelistOf(['GLM-5.3', 'fresh-new', 'local-extra']),
      }).fetchModels(dummyCredential)
      // 大小写不同的同一个 id 只留一行（匹配时不区分大小写，命中本地行则沿用
      // 本地行原样，含它自己的 id 拼写），空 id 不产生行；上游新 id 出现，
      // 本地未被上游列出的 local-extra 保留在末尾。
      expect(models.map(m => m.id)).toEqual(['GLM-5.3', 'fresh-new', 'local-extra'])
      expect(models.find(m => m.id === 'GLM-5.3')?.contextWindow).toBe(1000000)
      vi.unstubAllGlobals()
    })

    it('白名单不可得（undefined）时回退 this.models，且不请求上游', async () => {
      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
        code: 200,
        data: [{ id: 'brand-new-model' }],
      }), { status: 200 }))
      vi.stubGlobal('fetch', fetchSpy)
      const models = await new ZCodeUpstreamClient({
        models: FALLBACK_ZCODE_MODELS,
        resolveCodingPlanWhitelist: () => undefined,
      }).fetchModels(dummyCredential)
      // 产品面真源不可得 → 保守回退已注册名单；此时上游目录不可信，
      // 不值得为它发请求（白名单是闸门，不是事后过滤器）。
      expect(models.map(m => m.id)).toEqual(['glm-5.3', 'glm-5.3-flash'])
      expect(fetchSpy).not.toHaveBeenCalled()
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

  describe('ZCode Coding Plan whitelist from client builtin config', () => {
    it('从客户端 providerRules 中提取 bigmodel coding-plan 的 builtinModelIds', () => {
      // 形状取自实测 revision 30:zai 系与 start-plan 条目共存于同一列表,
      // 但白名单只并 bigmodel 的 coding-plan 两个条目。
      const config = {
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: 'account:zai-individual-coding-plan', config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' }, builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } },
              { providerId: 'account:bigmodel-individual-coding-plan', providerName: 'BigModel Individual Coding Plan', config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'bigmodel' }, builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } },
              { providerId: 'account:bigmodel-team-coding-plan', providerName: 'BigModel Team Coding Plan', config: { access: { type: 'zhipu-account', mode: 'team-coding-plan', accountType: 'bigmodel' }, builtinModelIds: ['GLM-5.3'] } },
              { providerId: 'account:bigmodel-start-plan', providerName: 'Start Plan', config: { access: { type: 'zhipu-account', mode: 'start-plan', accountType: 'bigmodel' }, builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'] } },
            ],
          },
        },
      }
      const whitelist = codingPlanWhitelistFromConfig(config)
      expect([...(whitelist ?? [])].sort()).toEqual(['glm-5.3', 'glm-5.3-flash'])
    })

    it('id 大小写与首尾空白容忍', () => {
      const config = {
        config: {
          providerConfigRules: {
            providerRules: [
              { providerId: 'account:bigmodel-individual-coding-plan', config: { access: { accountType: 'bigmodel' }, builtinModelIds: [' GLM-5.3 ', 'GLM-5.3-Flash'] } },
            ],
          },
        },
      }
      expect([...(codingPlanWhitelistFromConfig(config) ?? [])]).toEqual(['glm-5.3', 'glm-5.3-flash'])
    })

    it('找不到条目/结构缺失/字段缺失/accountType 不符一律 undefined（降级语义）', () => {
      expect(codingPlanWhitelistFromConfig(undefined)).toBeUndefined()
      expect(codingPlanWhitelistFromConfig({})).toBeUndefined()
      expect(codingPlanWhitelistFromConfig({ config: { providerConfigRules: { providerRules: [] } } })).toBeUndefined()
      // builtinModelIds 缺失:更像客户端结构演进,降级而不是显示空分组。
      expect(codingPlanWhitelistFromConfig({
        config: { providerConfigRules: { providerRules: [
          { providerId: 'account:bigmodel-individual-coding-plan', config: { access: { accountType: 'bigmodel' } } },
        ] } },
      })).toBeUndefined()
      // accountType 不是 bigmodel（Z.AI 系走另一条通道）。
      expect(codingPlanWhitelistFromConfig({
        config: { providerConfigRules: { providerRules: [
          { providerId: 'account:bigmodel-individual-coding-plan', config: { access: { accountType: 'zai' }, builtinModelIds: ['glm-5.3'] } },
        ] } },
      })).toBeUndefined()
    })

    it('ZCODE_BUILTIN_CONFIG 覆盖口：显式路径优先于平台候选', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'zcode-builtin-'))
      CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
      const file = join(dir, 'zcode-builtin.json')
      await writeFile(file, JSON.stringify({
        config: { providerConfigRules: { providerRules: [
          { providerId: 'account:bigmodel-team-coding-plan', config: { access: { accountType: 'bigmodel' }, builtinModelIds: ['GLM-5.3'] } },
        ] } },
      }))
      vi.stubEnv('ZCODE_BUILTIN_CONFIG', file)
      try {
        const whitelist = readZcodeCodingPlanWhitelist()
        expect([...(whitelist ?? [])]).toEqual(['glm-5.3'])
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('用白名单过滤历史 saved 名单（旧版本写入的越界模型）', () => {
      // 实测 2026-10-08：升级用户的 saved 目录里躺着 11 个模型（旧代码写的并集），
      // 启动时会先于 live 拉取发布——必须用同一份白名单过滤。
      const saved = [{ id: 'glm-5.3' }, { id: 'GLM-4.5' }, { id: 'glm-5.3-flashx' }]
      expect(filterByCodingPlanWhitelist(saved, new Set(['glm-5.3', 'glm-5.3-flash']))).toEqual([{ id: 'glm-5.3' }])
      // 白名单不可得 → 原样返回（不因读不到客户端文件就抹掉整组）。
      expect(filterByCodingPlanWhitelist(saved, undefined)).toEqual(saved)
    })

    it.skipIf(process.platform !== 'darwin')('本机 ZCode 客户端（若安装）解析出官方 GLM 白名单', () => {
      const whitelist = readZcodeCodingPlanWhitelist()
      if (whitelist === undefined) return // 未安装 ZCode 的 macOS：无可断言，跳过语义
      expect(whitelist.has('glm-5.3')).toBe(true)
      expect(whitelist.has('glm-5.3-flash')).toBe(true)
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

describe('Start Plan 专属通道（额度绝不与 Coding Plan 混用）', () => {
  const startPlanCredential: WorkBuddyCredential = {
    accessToken: 'ind-id.ind-secret',
    refreshToken: '',
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    domain: 'bigmodel.cn',
    uid: 'test-id',
    nickname: 'ZCode User',
    source: 'desktop',
    zcodePlan: 'start-plan',
    zcodeJwtToken: 'jwt-token',
    zcodeDeviceMid: 'mid-1',
  }

  afterEach(() => { vi.unstubAllGlobals() })

  it('start-plan 生效计划路由到 zcode-plan/anthropic，鉴权用 JWT+设备号（无 V4 签名）', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('event: ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const client = new ZCodeUpstreamClient()
    const result = await client.chatStream(startPlanCredential, JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 1, messages: [] }))
    expect(result.ok).toBe(true)
    expect(mockFetch.mock.calls[0]![0]).toBe('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages')
    const headers = ((mockFetch.mock.calls[0]![1] ?? {}) as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer jwt-token')
    expect(headers['X-Device-Mid']).toBe('mid-1')
    expect(headers['X-Client-Sig']).toBeUndefined()
  })

  it('start-plan 请求体带上官方客户端指纹，Harness 自己的 system 提示词接在其后', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('event: ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const client = new ZCodeUpstreamClient()
    const ownPrompt = 'You are DSH, the DeepSeek Harness coding agent.'
    await client.chatStream(startPlanCredential, JSON.stringify({
      model: 'glm-5.3-flash',
      max_tokens: 1,
      system: ownPrompt,
      messages: [{ role: 'user', content: 'hi' }],
    }))
    const sent = JSON.parse(String(((mockFetch.mock.calls[0]![1] ?? {}) as RequestInit).body)) as {
      system: Array<{ type: string; text: string }>
    }
    expect(sent.system[0]?.text).toBe(ZCODE_CLIENT_IDENTITY)
    expect(sent.system[1]?.text).toBe(ZCODE_CLIENT_PREFIX)
    // 指纹之外自己的提示词必须原样保留——否则就是拿官方身份顶掉了 DSH 的指令。
    expect(sent.system[2]?.text).toBe(ownPrompt)
  })

  it('已带指纹的请求体不重复叠加（重试/重放安全）', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('event: ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const client = new ZCodeUpstreamClient()
    const body = prepareStartPlanBody(JSON.stringify({ model: 'glm-5.3-flash', max_tokens: 1, messages: [] }))
    await client.chatStream(startPlanCredential, body)
    const sent = JSON.parse(String(((mockFetch.mock.calls[0]![1] ?? {}) as RequestInit).body)) as {
      system: Array<{ text: string }>
    }
    expect(sent.system).toHaveLength(2)
  })

  it('coding-plan 生效计划即使携带 zcodejwttoken 仍走普通通道', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('event: ok', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const mockSigner = { buildHeaders: async () => ({ 'x-mock-signer': '1' }) } as unknown as ZCodeClientSigner
    const client = new ZCodeUpstreamClient({ signer: mockSigner })
    const result = await client.chatStream({ ...startPlanCredential, zcodePlan: 'individual-coding-plan' }, '{}')
    expect(result.ok).toBe(true)
    expect(mockFetch.mock.calls[0]![0]).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
  })

  it('缺 zcodejwttoken 时明确报错且不发请求', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const client = new ZCodeUpstreamClient()
    const result = await client.chatStream({ ...startPlanCredential, zcodeJwtToken: undefined }, '{}')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('zcodejwttoken')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('3012 风控拦截映射为明确报错（说明未消耗额度、且不谎称通道被封），绝不回落普通通道', async () => {
    const mockFetch = vi.fn(async () => new Response(
      JSON.stringify({ code: 3012, msg: 'request has been blocked due to unusual activity.' }),
      { status: 405 },
    ))
    vi.stubGlobal('fetch', mockFetch)
    const client = new ZCodeUpstreamClient()
    const result = await client.chatStream(startPlanCredential, '{}')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('3012')
      expect(result.message).toContain('未消耗任何额度')
      expect(result.message).toContain('请求体指纹')
      expect(result.message).toContain('Coding Plan')
    }
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('start-plan 额度查 billing/balance 并映射 token 数与活动名', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [{ name: 'ZCode Trust Build', plan_id: 'zcode-v3-start-plan-trust-0930', ends_at: 1790784000 }],
        balances: [{
          show_name: 'GLM-5.3-Flash',
          plan_id: 'zcode-v3-start-plan-trust-0930',
          total_units: 100000000,
          used_units: 5701561,
          remaining_units: 94298439,
          expires_at: 1790784000,
        }],
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const credits = await new ZCodeUpstreamClient().fetchCredits(startPlanCredential)
    expect(credits.total).toBe(94298439)
    expect(credits.accounts[0]?.planName).toBe('ZCode Trust Build')
    expect(credits.accounts[0]?.remain).toBe(94298439)
    expect(credits.accounts[0]?.size).toBe(100000000)
    expect(credits.accounts[0]?.expiredAt).toBe(new Date(1790784000 * 1000).toISOString())
    // 当日一次性池子：卡片据此声明"不结转"，而不是让它读成可累积余额。
    expect(credits.accounts[0]?.sameDay).toBe(true)
    const headers = ((mockFetch.mock.calls[0]![1] ?? {}) as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer jwt-token')
    expect(headers['X-Device-Mid']).toBe('mid-1')
  })

  it('模型名单按活动 entitlements 派生：只登记活动实际放行的模型', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [{
          plan_id: 'zcode-v3-start-plan-trust-0930',
          name: 'ZCode Trust Build',
          status: 'active',
          entitlements: [
            { entitlement_id: 'e1', show_name: 'GLM-5.3-Flash', capabilities: ['model:glm-5.3-flash'] },
          ],
        }],
        balances: [],
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    // 实测：Trust Build 只放行 GLM-5.3-Flash，另外两个内置候选 400 code 3006。
    expect(models.map(model => model.id)).toEqual(['glm-5.3-flash'])
    expect(models[0]?.name).toBe('GLM-5.3-Flash')
    const headers = ((mockFetch.mock.calls[0]![1] ?? {}) as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer jwt-token')
    expect(headers['X-Device-Mid']).toBe('mid-1')
  })

  it('授权信息拿不到时退回已注册名单，而不是让分组消失', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    expect(models.map(model => model.id)).toEqual(FALLBACK_ZCODE_START_PLAN_MODELS.map(model => model.id))
  })

  /**
   * 状态 B：查询**成功**但此刻没有任何有效活动。今日确实一个模型都没授权，
   * 必须如实返回空名单让分组隐藏。
   *
   * 回退兜底名单会造出三个上游根本不放行的模型（实测 GLM-5.2 / GLM-5-Turbo
   * 返回 `400 code 3006 model not allowed`），把"今日无模型"伪装成"有三个模型"。
   */
  it('查询成功但没有有效活动（今日未领取）返回空名单，不回退兜底名单', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { plans: [], balances: [] },
    }), { status: 200 })))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    expect(models).toEqual([])
  })

  it('活动已过期（ends_at 秒级已过）同样返回空名单', async () => {
    const endedAtSec = Math.floor(Date.now() / 1000) - 60
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [{
          plan_id: 'zcode-v3-start-plan-trust-0930',
          name: 'ZCode Trust Build',
          status: 'active',
          ends_at: endedAtSec,
          entitlements: [
            { entitlement_id: 'e1', show_name: 'GLM-5.3-Flash', capabilities: ['model:glm-5.3-flash'] },
          ],
        }],
        balances: [],
      },
    }), { status: 200 })))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    expect(models).toEqual([])
  })

  it('过期活动与有效活动混在一起时，只登记有效活动放行的模型', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [
          {
            plan_id: 'expired', name: '旧活动', status: 'active', ends_at: nowSec - 60,
            entitlements: [{ show_name: 'GLM-5.2', capabilities: ['model:glm-5.2'] }],
          },
          {
            plan_id: 'live', name: '当前活动', status: 'active', ends_at: nowSec + 3600,
            entitlements: [{ show_name: 'GLM-5.3-Flash', capabilities: ['model:glm-5.3-flash'] }],
          },
        ],
        balances: [],
      },
    }), { status: 200 })))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    // 过期活动放行的 glm-5.2 必须被剔除。
    expect(models.map(model => model.id)).toEqual(['glm-5.3-flash'])
  })

  it('状态非 active 的活动不参与派生；ends_at 缺失时保守按有效处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [{
          name: '已下线活动', status: 'expired',
          entitlements: [{ show_name: 'GLM-5.2', capabilities: ['model:glm-5.2'] }],
        }],
        balances: [],
      },
    }), { status: 200 })))
    expect(await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)).toEqual([])

    // ends_at 缺失：不能因为字段缺失就让用户丢名单。
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [{
          name: '无 ends_at 活动', status: 'active',
          entitlements: [{ show_name: 'GLM-5.3-Flash', capabilities: ['model:glm-5.3-flash'] }],
        }],
        balances: [],
      },
    }), { status: 200 })))
    expect((await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)).map(model => model.id)).toEqual(['glm-5.3-flash'])
  })

  /**
   * 活跃活动但零可解析模型：走到这一步说明**已确认有有效活动**，名单的权威来源
   * 就是该活动的 entitlements。此时回退 this.models 对 start-plan 变体而言就是回退
   * 兜底那三个模型（index.ts 用 FALLBACK_ZCODE_START_PLAN_MODELS 构造 client），
   * 于是授权字段漂移会重新长出"看起来能用、一用就 400 code 3006"的幻影名单——
   * 与"未领取却显示模型"是同一个用户可见症状，只是触发条件更窄。
   */
  it('活动有效但 entitlements 为空数组时返回空名单，不回退幻影名单', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [{
          plan_id: 'zcode-v3-start-plan-trust-0930',
          name: 'ZCode Trust Build',
          status: 'active',
          ends_at: nowSec + 3600,
          entitlements: [],
        }],
        balances: [],
      },
    }), { status: 200 })))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    expect(models).toEqual([])
  })

  it('活动有效但 capabilities 全为非 model: 项时返回空名单，不回退幻影名单', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        plans: [{
          plan_id: 'zcode-v3-start-plan-trust-0930',
          name: 'ZCode Trust Build',
          status: 'active',
          ends_at: nowSec + 3600,
          entitlements: [
            { entitlement_id: 'e1', show_name: '   ', capabilities: ['meter:usage'] },
          ],
        }],
        balances: [],
      },
    }), { status: 200 })))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    expect(models).toEqual([])
  })

  it('状态 C：查询抛错（网络失败）仍回退已注册名单', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    expect(models.map(model => model.id)).toEqual(FALLBACK_ZCODE_START_PLAN_MODELS.map(model => model.id))
  })

  it('响应体不是 JSON（解析失败）仍回退已注册名单', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })))
    const models = await new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_START_PLAN_MODELS })
      .fetchModels(startPlanCredential)
    expect(models.map(model => model.id)).toEqual(FALLBACK_ZCODE_START_PLAN_MODELS.map(model => model.id))
  })

  it('额度查询失败如实抛错，绝不拿 Coding Plan 的订阅状态冒充', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    await expect(new ZCodeUpstreamClient().fetchCredits(startPlanCredential)).rejects.toThrow('Start Plan 额度查询失败')
  })

  /**
   * 今日待领取探测（task-3）。它是**提示性**信息而非名单/额度，所以失败一律
   * 降级成结果值、绝不抛错：挂在卡片每 60s 轮询的读路径上，一次上游抖动不能
   * 把整份 status 文档打挂。
   */
  describe('fetchStartPlanClaimPreview', () => {
    const appVersionStub = { resolveAppVersion: async () => ({ version: '3.4.0', source: 'fallback' as const }) }

    it('查到可领取项：带回 plan_id/name，请求带上 app_version 与 platform', async () => {
      const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
        code: 0,
        data: {
          plans: [
            { plan_id: 'low', name: '次要活动', priority: 1 },
            { plan_id: 'zcode-v3-start-plan-trust-0930', name: 'ZCode Trust Build', priority: 9 },
          ],
        },
      }), { status: 200 }))
      vi.stubGlobal('fetch', mockFetch)
      const result = await new ZCodeUpstreamClient(appVersionStub).fetchStartPlanClaimPreview(startPlanCredential)
      expect(result.status).toBe('ok')
      if (result.status !== 'ok') return
      // priority 高者在前：卡片提示的就是用户最该先领的那个。
      expect(result.plans.map(plan => plan.planId)).toEqual(['zcode-v3-start-plan-trust-0930', 'low'])
      const url = String(mockFetch.mock.calls[0]![0])
      expect(url).toContain('/api/v1/zcode-plan/billing/preview')
      expect(url).toContain('app_version=3.4.0')
      expect(url).toContain(`platform=${process.platform}-${os.arch()}`)
      const headers = ((mockFetch.mock.calls[0]![1] ?? {}) as RequestInit).headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer jwt-token')
      expect(headers['X-Device-Mid']).toBe('mid-1')
      // 探测不需要验证码：绝不带 captcha 头，否则就是在伪造验证结果。
      expect(headers['X-Aliyun-Captcha-Verify-Param']).toBeUndefined()
    })

    it('今日已领取（plans 为空）返回 ok + 空清单，不是失败', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { plans: [] } }), { status: 200 })))
      const result = await new ZCodeUpstreamClient(appVersionStub).fetchStartPlanClaimPreview(startPlanCredential)
      expect(result).toEqual({ status: 'ok', plans: [] })
    })

    it('上游 500 降级为 failed 结果值，不抛错', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
      const result = await new ZCodeUpstreamClient(appVersionStub).fetchStartPlanClaimPreview(startPlanCredential)
      expect(result.status).toBe('failed')
    })

    it('网络抛错同样降级为 failed，绝不冒泡给 status 路由', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
      const result = await new ZCodeUpstreamClient(appVersionStub).fetchStartPlanClaimPreview(startPlanCredential)
      expect(result.status).toBe('failed')
    })

    it('401 归 auth-failed（与"没得领"区分）', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 3001, msg: 'unauthorized' }), { status: 401 })))
      const result = await new ZCodeUpstreamClient(appVersionStub).fetchStartPlanClaimPreview(startPlanCredential)
      expect(result.status).toBe('auth-failed')
    })

    it('缺 zcodejwttoken 时直接 auth-failed 且不发请求', async () => {
      const mockFetch = vi.fn()
      vi.stubGlobal('fetch', mockFetch)
      const result = await new ZCodeUpstreamClient(appVersionStub)
        .fetchStartPlanClaimPreview({ ...startPlanCredential, zcodeJwtToken: undefined })
      expect(result.status).toBe('auth-failed')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('版本解析失败时退回编译期兜底版本，探测照常发出', async () => {
      const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: 0, data: { plans: [] } }), { status: 200 }))
      vi.stubGlobal('fetch', mockFetch)
      const result = await new ZCodeUpstreamClient({
        resolveAppVersion: async () => { throw new Error('no plist') },
      }).fetchStartPlanClaimPreview(startPlanCredential)
      expect(result.status).toBe('ok')
      expect(String(mockFetch.mock.calls[0]![0])).toContain(`app_version=${FALLBACK_APP_VERSION}`)
    })

    it('外部 signal 已中止时降级为 failed（status 读路径靠它限时）', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('aborted') }))
      const controller = new AbortController()
      controller.abort(new Error('status read budget exceeded'))
      const result = await new ZCodeUpstreamClient(appVersionStub)
        .fetchStartPlanClaimPreview(startPlanCredential, { signal: controller.signal })
      expect(result.status).toBe('failed')
    })
  })
})

