import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as WorkBuddy from '../src/index.js'

// 集成测试必须与宿主机真实 zcode 登录态隔离：跟随 zcode 的凭据来源统一
// 打成「无 zcode 凭据」，登录态只由测试显式给出（配置/env/文件）。
vi.mock('../src/zcode-credentials.js', () => ({
  readZcodeClientCredentials: async () => undefined,
}))

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private storedDocument: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.storedDocument))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.storedDocument[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

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
    await ctx.plugin(MemorySettings)
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

    // The section is what the Models settings page joins on to render a card.
    const descriptor = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(descriptor).toBeDefined()

    // No credential anywhere: the group is hidden (empty), not fallback-filled.
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('workbuddy')).toEqual([])
    })

    // A settings write validates against the schema and persists.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { authFile: '/tmp/other-workbuddy.info' })
    const updated = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['authFile']).toBe('/tmp/other-workbuddy.info')
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
      await ctx.plugin(MemorySettings)
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

    // A settings write validates against the schema and persists.
    await ctx.settings.update(WorkBuddy.WORKBUDDY_SETTINGS_NS, { authFile: '/tmp/other-workbuddy.info' })
    const updated = ctx.settings.describe().find(entry => entry.ns === WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect((updated?.value as Record<string, unknown>)['authFile']).toBe('/tmp/other-workbuddy.info')
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
      await ctx1.plugin(MemorySettings)
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
      await ctx.plugin(MemorySettings)
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
    await ctx.plugin(MemorySettings)

    // 假时钟从插件安装前开启:installSection 安装即触发一次 onChange 拉取,
    // shim 就绪后再来一次启动拉取——两条失败链各自带重试。
    vi.useFakeTimers()
    try {
      await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
      // waitFor 在假时钟下自动按 50ms 推进(上限 1s,远够不到 60s 重试点),
      // 等两条链的首次失败都落地。
      await vi.waitFor(() => { expect(calls).toBe(2) })
      // 假时钟推进只负责触发重试定时器;重试回调里的 fs 读取走真实 I/O,
      // 用真实时钟小步等待其收敛(Date 已被假时钟接管,不读钟)。
      const waitForReal = async (expected: number): Promise<void> => {
        for (let i = 0; i < 200 && calls < expected; i += 1) await realSleep(10)
        expect(calls).toBe(expected)
      }
      // 第一次重试:两条链各 +1。
      await vi.advanceTimersByTimeAsync(60_000)
      await waitForReal(4)
      // 第二次重试(每链最后一次)。
      await vi.advanceTimersByTimeAsync(60_000)
      await waitForReal(6)
      // 重试耗尽(每链初始 1 次 + 最多 2 次),不再发起。
      await vi.advanceTimersByTimeAsync(180_000)
      for (let i = 0; i < 20; i += 1) await realSleep(10)
      expect(calls).toBe(6)
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
    await ctx.plugin(MemorySettings)
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
    const namespaces = ctx.settings.describe().map(entry => entry.ns)
    expect(namespaces).toContain(WorkBuddy.WORKBUDDY_ZCODE_SETTINGS_NS)
    expect(namespaces).toContain(WorkBuddy.WORKBUDDY_ZCODE_OFFPEAK_SETTINGS_NS)
  })

  it('serves the GLM roster once a key is configured, and hides it again after the key is cleared', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-zcode-roster-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {
      authFile: join(root, 'no-such-file.info'),
      authFileAI: join(root, 'no-such-ai-file.info'),
      apiKeyZcode: 'plan-key-123456',
    })
    // WorkBuddy 侧无凭据保持隐藏；zcode 静态名单可见，id 用上游大写拼写。
    await vi.waitFor(async () => {
      const ids = (await ctx.llm.listModels('zcode')).map(m => m.id)
      expect(ids).toContain('GLM-5.3')
      expect(ids).toContain('GLM-5.3-Flash')
      expect(ids).toContain('GLM-5.2')
      expect(ids).toContain('GLM-5-Turbo')
    })
    expect(await ctx.llm.listModels('workbuddy')).toEqual([])

    // 设置卡清空 key（schemastery 会物化成空字符串）→ 分组隐藏。
    // （env 兜底的优先级链由 zcode.test.ts 的 store 用例覆盖；这里不依赖
    // 「同值 settings.update 是否触发 onChange」的宿主语义。）
    await ctx.settings.update(WorkBuddy.WORKBUDDY_ZCODE_SETTINGS_NS, { apiKeyZcode: '' })
    await vi.waitFor(async () => {
      expect(await ctx.llm.listModels('zcode')).toEqual([])
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
    await ctx.plugin(MemorySettings)
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
    const namespaces = ctx.settings.describe().map(entry => entry.ns)
    expect(namespaces).toContain(WorkBuddy.WORKBUDDY_SETTINGS_NS)
    expect(namespaces).toContain(WorkBuddy.WORKBUDDY_AI_SETTINGS_NS)
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
      await ctx.plugin(MemorySettings)
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
