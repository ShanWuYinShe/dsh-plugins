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
  it('exposes the provider directory entry, the settings section, and the fallback model list', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-settings-'))
    vi.stubEnv('DSH_HOME', root)
    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WorkBuddy, {})

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

    const models = await ctx.llm.listModels('workbuddy')
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
      await ctx.plugin(WorkBuddy, { authFile: desktop })
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
