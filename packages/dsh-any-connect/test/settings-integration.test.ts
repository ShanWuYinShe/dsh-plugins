import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.js'

// 集成测试必须与宿主机真实 zcode 登录态隔离：跟随 zcode 的凭据来源统一
// 打成「无 zcode 凭据」，登录态只由测试显式给出（配置/env/文件）。
vi.mock('../src/zcode-credentials.js', () => ({
  readZcodeClientCredentials: async () => undefined,
}))

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

describe('WorkBuddy Host settings integration', () => {
  it('registers the provider and settings section, but hides the model group while signed out', async () => {
    // 无凭据行为（与上游 dsh-workbuddy-connect 一致）：从未登录、也没有插件
    // 自留副本时，模型分组不再显示——此前会展示一份内置兜底名单，但那些模型
    // 选了必然报错。provider 注册与设置区不受影响，登录后无需重新注册。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-settings-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    // Point the desktop probe at a path that cannot exist: the test must be
    // hermetic (CI runners may carry a real signed-in desktop file, which
    // would flip this case to signed-in). An explicit authFile overrides the
    // platform defaults to this single path.
    await ctx.plugin(WorkBuddy, { authFile: join(root, 'no-such-file.info'), authFileAI: join(root, 'no-such-ai-file.info') })

    // Registration rides on the loopback shim's listening event.
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'workbuddy',
      displayName: 'WorkBuddy',
      settingsNs: 'anyconnect',
      settingsPath: [],
      declared: false,
    })

    // The directory entries are what the Models settings page joins on to
    // render a card. Without a Loader the settingsNs falls back to the
    // legacy namespace constants.
    const directory = ctx.llm.listConfigurableProviders()
    for (const [provider, settingsNs] of [
      ['workbuddy', WorkBuddy.WORKBUDDY_SETTINGS_NS],
      ['workbuddy-ai', WorkBuddy.WORKBUDDY_AI_SETTINGS_NS],
      ['zcode', WorkBuddy.WORKBUDDY_ZCODE_SETTINGS_NS],
      ['zcode-offpeak', WorkBuddy.WORKBUDDY_ZCODE_OFFPEAK_SETTINGS_NS],
    ] as const) {
      expect(directory).toContainEqual({
        provider,
        displayName: expect.any(String),
        settingsNs,
        settingsPath: [],
        declared: false,
      })
    }

    // No credential anywhere: the group is hidden (empty), not fallback-filled.
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })
  })

  it('serves the fallback model list once signed in (fetch failing)', async () => {
    // 已登录但上游拉取失败：分组可见，服务内置兜底名单（上一个用例的反面）。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-fallback-'))
    vi.stubEnv('DSH_HOME', root)
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1', nickname: '昵称' },
    }))
    const spy = vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => { throw new Error('upstream down') })
    try {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
        await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
      await vi.waitFor(() => {
        expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
      })
      let models = await ctx.llm.listModels('workbuddy')
      if (models.length === 0) {
        // 启动拉取是异步的：等 fallback 落定（身份已确认、fetch 已失败）。
        await vi.waitFor(async () => {
          models = await ctx.llm.listModels('workbuddy')
          expect(models.length).toBeGreaterThan(0)
        })
      }
    expect(models.map(model => model.id)).toContain('auto')
    expect(models.map(model => model.id)).toContain('deepseek-v4-pro')
    // The fallback catalog tracks the live `cli` roster, including the newer
    // models the desktop app offers that older builds lacked.
    expect(models.map(model => model.id)).toContain('hy4-preview')
    expect(models.map(model => model.id)).toContain('glm-5.3')

    // The billing rate rides the display name only: surfaces that render
    // name + description showed the rate twice when it also filled the
    // description, so the description now carries the upstream marketing copy
    // (absent in the fallback list) instead. The id and the request path are
    // untouched by this display-only decoration.
    const byId = new Map(models.map(model => [model.id, model]))
    expect(byId.get('glm-5.2')?.name).toBe('GLM-5.2 · x0.79')
    expect(byId.get('glm-5.2')?.description).toBeUndefined()
    expect(byId.get('glm-5.1')?.name).toBe('GLM-5.1 · x0.79')
    expect(byId.get('auto')?.name).toBe('Auto')
    expect(byId.get('auto')?.description).toBeUndefined()

    // Image modalities follow the per-model catalog flag (fallback list here):
    // image-capable entries expose `image`, glm-5.1 stays text-only.
    const modalities = new Map(models.map(model => [model.id, model.inputModalities]))
    expect(modalities.get('auto')).toContain('image')
    expect(modalities.get('glm-5.1')).toEqual(['text'])
    } finally {
      spy.mockRestore()
    }
  })

  it('serves the saved catalog after a restart when the fetch keeps failing', async () => {
    // saved 优先于 fallback：一次成功拉取落盘后，即使重启且上游持续失败，
    // 该账号看到的仍是"自己实际被服务过"的名单，而非编译期快照。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-saved-'))
    vi.stubEnv('DSH_HOME', root)
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1', nickname: '昵称' },
    }))
    const savedRow = { id: 'saved-only', name: 'Saved Only', contextWindow: 100, maxTokens: 10, supportsImages: false }
    // 第一程：拉取成功 → 落盘。
    const okSpy = vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => [savedRow])
    const ctx1 = new Context()
    try {
      await ctx1.plugin(LlmRuntime)
      await ctx1.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
      await vi.waitFor(async () => {
        expect((await ctx1.llm.listModels('workbuddy')).map(m => m.id)).toContain('saved-only')
      })
      // set 先于 save 落盘：等文件出现再"重启"，否则第二程读不到 saved。
      const { existsSync } = await import('node:fs')
      await vi.waitFor(() => {
        expect(existsSync(join(root as string, '.workbuddy-catalog.json'))).toBe(true)
      })
    } finally {
      okSpy.mockRestore()
      await ctx1.fiber.dispose()
    }
    // 第二程（重启）：拉取持续失败 → 服务 saved，不回落 fallback。
    const failSpy = vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => { throw new Error('upstream down') })
    try {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
        await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
      await vi.waitFor(async () => {
        expect((await ctx.llm.listModels('workbuddy')).map(m => m.id)).toContain('saved-only')
      })
    } finally {
      failSpy.mockRestore()
    }
  })

  it('retries the model catalog refresh after failures, then stops', async () => {
    // 目录重试回归:启动拉取失败后曾永不重试,目录(费率/徽章)会一直停在
    // fallback 快照。失败后应按 60s 间隔有限次重试,耗尽即停,不再打扰。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-catalog-'))
    vi.stubEnv('DSH_HOME', root)
    // 已登录且 token 未过期:resolve() 不触网,fetchModels 是唯一上游触点。
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-1', nickname: '昵称' },
    }))
    let calls = 0
    const spy = vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => {
        calls += 1
        throw new Error('upstream down')
      })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)

    // 假时钟从插件安装前开启。DSH 0.1.7 起配置是 volatile 引用、启动只有
    // shim 就绪后的一次拉取（旧 installSection 的装配期 onChange 拉取已随
    // settings provider 一并移除）：单条失败链带重试。
    vi.useFakeTimers()
    try {
      await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
      // waitFor 在假时钟下自动按 50ms 推进(上限 1s,远够不到 60s 重试点),
      // 等首次失败落地。
      await vi.waitFor(() => { expect(calls).toBe(1) })
      // 假时钟推进只负责触发重试定时器;重试回调里的 fs 读取走真实 I/O,
      // 用真实时钟小步等待其收敛(Date 已被假时钟接管,不读钟)。
      const waitForReal = async (expected: number): Promise<void> => {
        for (let i = 0; i < 200 && calls < expected; i += 1) await realSleep(10)
        expect(calls).toBe(expected)
      }
      // 第一次重试。
      await vi.advanceTimersByTimeAsync(60_000)
      await waitForReal(2)
      // 第二次重试(最后一次)。
      await vi.advanceTimersByTimeAsync(60_000)
      await waitForReal(3)
      // 重试耗尽(初始 1 次 + 最多 2 次),不再发起。
      await vi.advanceTimersByTimeAsync(180_000)
      for (let i = 0; i < 20; i += 1) await realSleep(10)
      expect(calls).toBe(3)
    } finally {
      vi.useRealTimers()
      spy.mockRestore()
    }
  })
})

describe('zcode provider (GLM Coding Plan)', () => {
  it('registers zcode and keeps its group hidden until a key is configured', async () => {
    // 与 WorkBuddy 变体同一显隐约定：无 key 时分组隐藏，provider 与设置区照常
    // 注册——key 配置（卡片/env/key 文件）之后无需重新注册。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WorkBuddy, {
      authFile: join(root, 'no-such-file.info'),
      authFileAI: join(root, 'no-such-ai-file.info'),
    })
    await vi.waitFor(() => {
      const ids = ctx.llm.listProviders().map(provider => provider.id)
      expect(ids).toContain('workbuddy')
      expect(ids).toContain('workbuddy-ai')
      expect(ids).toContain('zcode')
      expect(ids).toContain('zcode-offpeak')
    })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'zcode',
      displayName: 'ZCode',
      settingsNs: 'anyconnect-zcode',
      settingsPath: [],
      declared: false,
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('zcode')).toEqual([])
    })
    const entries = ctx.llm.listConfigurableProviders()
    expect(entries.map(entry => entry.provider)).toEqual(
      expect.arrayContaining(['workbuddy', 'workbuddy-ai', 'zcode', 'zcode-offpeak']),
    )
    expect(entries.find(entry => entry.provider === 'zcode')).toMatchObject({
      settingsNs: WorkBuddy.WORKBUDDY_ZCODE_SETTINGS_NS,
      settingsPath: [],
    })
    expect(entries.find(entry => entry.provider === 'zcode-offpeak')).toMatchObject({
      settingsNs: WorkBuddy.WORKBUDDY_ZCODE_OFFPEAK_SETTINGS_NS,
      settingsPath: [],
    })
  })

  it('serves the GLM roster once a key is configured, and hides it again after the key is cleared', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-roster-'))
    vi.stubEnv('DSH_HOME', root)
    const options = {
      authFile: join(root, 'no-such-file.info'),
      authFileAI: join(root, 'no-such-ai-file.info'),
      apiKeyZcode: 'plan-key-123456',
    }
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WorkBuddy, options)
    // WorkBuddy 侧无凭据保持隐藏；zcode 静态名单可见，id 用上游大写拼写。
    await vi.waitFor(async () => {
      const ids = (await ctx.llm.listModels('zcode')).map(m => m.id)
      expect(ids).toContain('GLM-5.3')
      expect(ids).toContain('GLM-5.3-Flash')
      expect(ids).toContain('GLM-5.2')
      expect(ids).toContain('GLM-5-Turbo')
    })
    expect(await ctx.llm.listModels('workbuddy')).toEqual([])

    // key 清空 → 分组隐藏。DSH 0.1.7 起配置变更走 Loader（volatile 引用或
    // 重装）；无 Loader 的测试以重装表达「同一配置项的下一次生效值」。
    // （env 兜底的优先级链由 zcode.test.ts 的 store 用例覆盖。）
    await context?.fiber.dispose()
    const ctx2 = new Context()
    context = ctx2
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(WorkBuddy, { ...options, apiKeyZcode: '' })
    await vi.waitFor(async () => {
      expect(await ctx2.llm.listModels('zcode')).toEqual([])
    })
  })
})

describe('WorkBuddy international variant', () => {
  it('registers both providers but hides each group independently', async () => {
    // 双分组独立显隐：都不登录时两个分组都隐藏，但 provider 注册与设置区
    // 都在——登录任一一侧都无需重新注册。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-dual-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WorkBuddy, {
      authFile: join(root, 'no-such-file.info'),
      authFileAI: join(root, 'no-such-ai-file.info'),
    })
    await vi.waitFor(() => {
      const ids = ctx.llm.listProviders().map(provider => provider.id)
      expect(ids).toContain('workbuddy')
      expect(ids).toContain('workbuddy-ai')
    })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
      expect(await ctx.llm.listModels('workbuddy-ai')).toEqual([])
    })
    const entries = ctx.llm.listConfigurableProviders()
    expect(entries.find(entry => entry.provider === 'workbuddy')).toMatchObject({
      settingsNs: WorkBuddy.WORKBUDDY_SETTINGS_NS,
      settingsPath: [],
    })
    expect(entries.find(entry => entry.provider === 'workbuddy-ai')).toMatchObject({
      settingsNs: WorkBuddy.WORKBUDDY_AI_SETTINGS_NS,
      settingsPath: [],
    })
  })

  it('serves the AI fallback roster when only the AI side is signed in', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-ai-'))
    vi.stubEnv('DSH_HOME', root)
    const desktopAI = join(root, 'workbuddy-desktop-ai.info')
    await writeFile(desktopAI, JSON.stringify({
      auth: { accessToken: 'ai-at', refreshToken: 'ai-rt', expiresAt: Date.now() + 3600_000, domain: 'www.workbuddy.ai' },
      account: { uid: 'ai-uid', nickname: 'AI 用户' },
    }))
    const spy = vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => { throw new Error('upstream down') })
    try {
      const ctx = new Context()
      context = ctx
      await ctx.plugin(LlmRuntime)
        await ctx.plugin(WorkBuddy, {
        authFile: join(root, 'no-such-file.info'),
        authFileAI: desktopAI,
      })
      await vi.waitFor(async () => {
        const ids = (await ctx.llm.listModels('workbuddy-ai')).map(m => m.id)
        expect(ids).toContain('default-model')
        expect(ids).toContain('gpt-5.6-luna')
      })
      // CN 侧无凭据：保持隐藏；AI 名单里没有 CN 专属 id。
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
      const aiIds = (await ctx.llm.listModels('workbuddy-ai')).map(m => m.id)
      expect(aiIds).not.toContain('auto')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('volatile configuration (DSH 0.1.7)', () => {
  it('repoints each variant store from the live values', () => {
    const credentialSet: Array<string | undefined> = []
    const keySet: Array<string | undefined> = []
    const stores = {
      credentialStore: { setDesktopPath: (path: string | undefined) => { credentialSet.push(path) } },
      zcodeStore: { setConfiguredKey: (key: string | undefined) => { keySet.push(key) } },
    }
    expect(WorkBuddy.applyVariantConfig(WorkBuddy.CN_VARIANT, stores, { authFile: '/tmp/a.info' })).toBe('authFile')
    expect(credentialSet).toEqual(['/tmp/a.info'])
    expect(WorkBuddy.applyVariantConfig(WorkBuddy.AI_VARIANT, stores, { authFileAI: '/tmp/ai.info' })).toBe('authFile')
    expect(credentialSet).toEqual(['/tmp/a.info', '/tmp/ai.info'])
    expect(WorkBuddy.applyVariantConfig(WorkBuddy.ZCODE_VARIANT, stores, { apiKeyZcode: 'k' })).toBe('apiKey')
    expect(keySet).toEqual(['k'])
    // off-peak 凭据跟随 zcode 登录态：无可编辑字段，不碰任何 store。
    expect(WorkBuddy.applyVariantConfig(WorkBuddy.ZCODE_OFFPEAK_VARIANT, stores, {})).toBeUndefined()
    expect(credentialSet).toHaveLength(2)
    expect(keySet).toHaveLength(1)
  })

  it('tolerates absent stores (variant without a live runtime part)', () => {
    expect(() => WorkBuddy.applyVariantConfig(WorkBuddy.CN_VARIANT, {}, { authFile: '/tmp/a.info' })).not.toThrow()
    expect(() => WorkBuddy.applyVariantConfig(WorkBuddy.ZCODE_VARIANT, {}, {})).not.toThrow()
  })

  it('survives a volatile-update with no Loader (install-time values, no crash)', async () => {
    // 无 Loader 时配置静态：事件只重读安装值并重走 refresh（此处无凭据，
    // 即 adoptSignedOut），不断言目录变化，只证明接线不抛错。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-volatile-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(WorkBuddy, {
      authFile: join(root, 'no-such-file.info'),
      authFileAI: join(root, 'no-such-ai-file.info'),
    })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    })
    expect(() => fiber.ctx.emit('loader/volatile-update', [])).not.toThrow()
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })
  })
})
