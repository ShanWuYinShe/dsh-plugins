import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as realSleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.js'
import type { WorkBuddyModelInfo } from '../src/index.js'

/**
 * Start Plan「领取后恢复」快通道的回归（task-8）。
 *
 * 现象（audit-refresh 实测）：Start Plan 今日未领取 → 模型名单为空 → 分组隐藏。
 * 用户去客户端领取后，插件要等**最长 60 分钟**（下一次小时刷新）才显示出来。
 * 原因是领取既不改变凭据身份、也不落在夜免边界上：60s 身份 sweep 的
 * shouldRefresh 恒为假，一切网。
 *
 * 修法：**仅当该变体的目录为空时**，在 60s sweep 里复用已有的 claim preview
 * 探测（纯 HTTP、无 captcha、3s 超时）；探到 available→none 翻转（= 用户刚
 * 领取）立刻触发一次 refreshCatalog，把恢复压到一拍。目录非空则完全不探测。
 */
const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = undefined
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function row(id: string): WorkBuddyModelInfo {
  return { id, name: id, contextWindow: 1000, maxTokens: 100, supportsImages: false }
}

/** 真实 I/O（凭据文件读取、shim 就绪）在假时钟下不会前进，用真实小睡等它收敛。 */
async function drain(until: () => boolean, budget = 400): Promise<void> {
  for (let waited = 0; waited < budget && !until(); waited += 10) await realSleep(10)
}

interface Harness {
  ctx: Context
  previewCalls: () => number
  modelsCalls: () => number
  serveClaimed: () => void
  setPreview: (mode: 'available' | 'none' | 'unavailable') => void
}

/**
 * 装真实 LlmRuntime + 插件，只让 ZCode 一侧登录（authFileZCode 指向临时凭据文档）。
 *
 * fetchModels / fetchStartPlanClaimPreview 换成可编程的桩：前者代表「今天领到了
 * 什么」，后者代表那条廉价的可领探测。
 */
async function install(home: string): Promise<Harness> {
  const dir = join(home, 'zcode')
  await mkdir(dir, { recursive: true })
  const credentials = join(dir, 'credentials.json')
  await writeFile(credentials, JSON.stringify({
    zcodejwttoken: 'jwt-token',
    device_mid: 'device-1',
    'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'ind-id.ind-secret',
  }))
  await writeFile(join(dir, 'setting.json'), JSON.stringify({
    providerFamilyDomain: 'bigmodel',
    providerFamilyConnectionSelections: { bigmodel: { kind: 'start-plan' } },
  }))

  let claimed = false
  let previewMode: 'available' | 'none' | 'unavailable' = 'available'
  let previewCalls = 0
  let modelsCalls = 0
  vi.spyOn(WorkBuddy.ZCodeUpstreamClient.prototype, 'fetchModels')
    .mockImplementation(async () => { modelsCalls += 1; return claimed ? [row('claimed-model')] : [] })
  vi.spyOn(WorkBuddy.ZCodeUpstreamClient.prototype, 'fetchStartPlanClaimPreview')
    .mockImplementation(async () => {
      previewCalls += 1
      if (previewMode === 'unavailable') throw new Error('probe exploded')
      return previewMode === 'available'
        ? { status: 'ok', plans: [{ planId: 'p1', name: 'Activity' }] } as never
        : { status: 'ok', plans: [] } as never
    })

  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  // 假时钟必须在插件安装**之前**开启：60s/1h 的 interval 才注册在假时钟上。
  vi.useFakeTimers()
  await ctx.plugin(WorkBuddy, {
    authFile: join(home, 'no-such-file.info'),
    authFileAI: join(home, 'no-such-ai-file.info'),
    authFileZCode: credentials,
  })
  await vi.waitFor(() => { expect(ctx.llm.listProviders().length).toBe(4) }, { timeout: 5000 })
  await drain(() => false, 300)
  return {
    ctx,
    previewCalls: () => previewCalls,
    modelsCalls: () => modelsCalls,
    serveClaimed: () => { claimed = true },
    setPreview: mode => { previewMode = mode },
  }
}

describe('Start Plan 空名单快通道（领取后 ≤60s 恢复）', () => {
  it('目录为空 + 探到 available→none 翻转 → 立刻重拉，不等小时刷新', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-claimflip-'))
    const h = await install(root)
    try {
      await vi.waitFor(async () => { expect(await h.ctx.llm.listModels('zcode-start-plan')).toEqual([]) }, { timeout: 5000 })
      expect(h.previewCalls()).toBe(0)

      // 第一拍：目录空 → 探测一次，记录「还可领」。
      await vi.advanceTimersByTimeAsync(60_000)
      await drain(() => h.previewCalls() >= 1)
      expect(h.previewCalls()).toBe(1)
      expect(await h.ctx.llm.listModels('zcode-start-plan')).toEqual([])

      // 用户去客户端领取：探测转为 none、上游开始给模型。
      h.setPreview('none')
      h.serveClaimed()
      const before = h.modelsCalls()
      await vi.advanceTimersByTimeAsync(60_000)
      await drain(() => h.previewCalls() >= 2)
      await vi.waitFor(async () => {
        expect((await h.ctx.llm.listModels('zcode-start-plan')).map(m => m.id)).toEqual(['claimed-model'])
      }, { timeout: 5000 })
      // 快通道确实触发了重拉（而不是恰好撞上小时刷新——这里只推进了 2 分钟）。
      expect(h.modelsCalls()).toBeGreaterThan(before)
    } finally {
      vi.useRealTimers()
    }
  }, 30000)

  it('目录非空 → 完全不探测（稳态零额外请求）', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-claimflip-idle-'))
    const h = await install(root)
    try {
      // 今天已经领到：目录非空。
      h.serveClaimed()
      h.ctx.fiber.ctx.emit('loader/volatile-update', [])
      await drain(() => false, 300)
      await vi.waitFor(async () => {
        expect((await h.ctx.llm.listModels('zcode-start-plan')).map(m => m.id)).toEqual(['claimed-model'])
      }, { timeout: 5000 })

      const probesBefore = h.previewCalls()
      // 推进若干拍 sweep：目录一直非空，一次探测都不该有。
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await drain(() => false, 400)
      expect(h.previewCalls()).toBe(probesBefore)
    } finally {
      vi.useRealTimers()
    }
  }, 30000)

  it('探测失败 → 不触发刷新、不误判翻转', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-claimflip-fail-'))
    const h = await install(root)
    try {
      await vi.waitFor(async () => { expect(await h.ctx.llm.listModels('zcode-start-plan')).toEqual([]) }, { timeout: 5000 })
      // 上拍探到 available（建立标记）……
      await vi.advanceTimersByTimeAsync(60_000)
      await drain(() => h.previewCalls() >= 1)
      const afterAvailable = h.modelsCalls()

      // ……这一拍探测直接抛错：必须被当成「没探到」，既不刷新也不改标记。
      h.setPreview('unavailable')
      await vi.advanceTimersByTimeAsync(60_000)
      await drain(() => h.previewCalls() >= 2)
      await drain(() => false, 300)
      expect(h.modelsCalls()).toBe(afterAvailable)
      expect(await h.ctx.llm.listModels('zcode-start-plan')).toEqual([])

      // 探测恢复后，标记仍是 available —— 再翻到 none 依然能触发（没被故障清掉）。
      h.setPreview('none')
      h.serveClaimed()
      await vi.advanceTimersByTimeAsync(60_000)
      await drain(() => h.previewCalls() >= 3)
      await vi.waitFor(async () => {
        expect((await h.ctx.llm.listModels('zcode-start-plan')).map(m => m.id)).toEqual(['claimed-model'])
      }, { timeout: 5000 })
    } finally {
      vi.useRealTimers()
    }
  }, 30000)
})
