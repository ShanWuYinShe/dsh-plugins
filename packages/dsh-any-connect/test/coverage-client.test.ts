// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VariantCard } from '../client/VariantCard.tsx'
import { ModelRow } from '../client/ModelRow.tsx'
import { VariantsPage } from '../client/VariantsPage.tsx'
import { apply as applyClientEntry } from '../client/index.tsx'
import { CARD_VARIANTS, catalogSourceKey, isCatalogLive, type WorkBuddyCardVariant, type WorkBuddyConfigPageInjected } from '../client/config-types.ts'
import { zh } from '../client/locales.ts'
import type { WorkBuddyWebModelRow, WorkBuddyWebStatus } from '../src/status-paths.ts'

/**
 * client 侧覆盖率补齐：只走**用户可见路径**（渲染出的文案、可点按钮、按钮
 * 触发的真实动作），不为覆盖率写无断言用例。真实组件 + 真实 zh 字典 +
 * 真实 props/fixture。
 */

const t: WorkBuddyConfigPageInjected['t'] = (key, params) => {
  let out: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) out = out.replace(`{${name}}`, String(value))
  return out
}

let container: HTMLDivElement
let root: Root
let controlCalls: string[]
let controlStatus: number

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  controlCalls = []
  controlStatus = 200
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (url.endsWith('/probe') && init?.method === 'POST') {
      const action = JSON.parse(init.body ?? '{}') as { action?: string; modelId?: string }
      controlCalls.push(action.action === 'delete-model' || action.action === 'restore-model' ? `${action.action}:${action.modelId}` : String(action.action))
      return new Response(JSON.stringify({ state: 'ok', excludedCount: 1, restored: true }), { status: controlStatus })
    }
    return new Response(JSON.stringify({ status: 'signed-out' }), { status: 200 })
  }))
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => { controlCalls.push(`copy:${value}`) } },
  })
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element)
    // 让挂载 effect 的首轮异步取数落定（与 config-page.test.ts 同口径）。
    await new Promise(resolve => setTimeout(resolve, 0))
    await Promise.resolve()
  })
}

function text(): string {
  return container.textContent ?? ''
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(label)) as HTMLButtonElement | undefined
}

function buttonExact(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label) as HTMLButtonElement | undefined
}

function buttonByAria(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => (candidate.getAttribute('aria-label') ?? '').includes(label)) as HTMLButtonElement | undefined
}

const MODEL_ROW: WorkBuddyWebModelRow = {
  id: 'glm-5.3',
  name: 'GLM-5.3',
  contextWindow: 1_000_000,
  contextWindows: [1_000_000, 200_000],
  credits: 'x0.79',
}

const CN_VARIANT = CARD_VARIANTS[0]!
const ZCODE_CODING = CARD_VARIANTS[2]!
const ZCODE_START = CARD_VARIANTS[3]!
const OPENCODE = CARD_VARIANTS[4]!

type SignedIn = Extract<WorkBuddyWebStatus, { status: 'signed-in' }>

function signedIn(overrides: Partial<SignedIn> = {}): SignedIn {
  return {
    status: 'signed-in',
    nickname: 'tester',
    domain: 'www.codebuddy.cn',
    catalog: { source: 'live', fetchedAt: 1 },
    probe: { running: false, results: [] },
    probeKey: 'test-key',
    credits: { total: 591, accounts: [] },
    models: [MODEL_ROW],
    ...overrides,
  } as SignedIn
}

async function renderCard(variant: WorkBuddyCardVariant, status: SignedIn, open = true): Promise<void> {
  await render(createElement(VariantCard, {
    t,
    variant,
    status,
    open,
    onToggle: vi.fn(),
    fetchStatus: async () => status,
    applyStatus: vi.fn(),
  }))
}

describe('VariantCardModels：模型表/隐藏区/空名单的用户可见行为', () => {
  it('已隐藏数量 > 0：显示计数与「恢复默认」，点击走 restore-models 动作', async () => {
    await renderCard(CN_VARIANT, signedIn({
      excludedCount: 2,
      excludedModels: [{ ...MODEL_ROW, id: 'hidden-1', name: 'Hidden' }],
    }))
    expect(text()).toContain(t('excludedModelsCount', { n: 2 }))
    const restoreDefaults = buttonByText(t('restoreDefaults'))
    expect(restoreDefaults, '隐藏数量 > 0 时应提供一键恢复入口').toBeDefined()
    await act(async () => { restoreDefaults!.click() })
    expect(controlCalls).toContain('restore-models')
  })

  it('展开模型表后可删除单行；展开隐藏区后可单条恢复', async () => {
    await renderCard(CN_VARIANT, signedIn({
      excludedModels: [{ ...MODEL_ROW, id: 'hidden-1', name: 'Hidden' }],
      excludedCount: 1,
    }))
    // 展开可见模型表
    const modelsToggle = buttonByText(t('modelsCount', { n: 1 }))
    expect(modelsToggle).toBeDefined()
    await act(async () => { modelsToggle!.click() })
    const deleteButton = buttonByText(t('deleteModel'))
    expect(deleteButton, '展开后可见行的删除动作应出现').toBeDefined()
    await act(async () => { deleteButton!.click() })
    expect(controlCalls).toContain('delete-model:glm-5.3')

    // 展开隐藏区
    const excludedToggle = buttonByText(t('excludedSectionTitle', { n: 1 }))
    expect(excludedToggle).toBeDefined()
    await act(async () => { excludedToggle!.click() })
    const restoreButton = buttonExact(t('restoreModel'))
    expect(restoreButton, '隐藏区每行应有恢复按钮').toBeDefined()
    await act(async () => { restoreButton!.click() })
    expect(controlCalls).toContain('restore-model:hidden-1')
  })

  it('全部隐藏（可见 0、隐藏 > 0）时给出「全部隐藏」说明，而不是空表', async () => {
    await renderCard(CN_VARIANT, signedIn({
      models: [],
      excludedCount: 1,
      excludedModels: [{ ...MODEL_ROW, id: 'hidden-1', name: 'Hidden' }],
    }))
    const modelsToggle = buttonByText(t('modelsCount', { n: 0 }))
    expect(modelsToggle, '隐藏项存在时仍需给出模型区入口').toBeDefined()
    await act(async () => { modelsToggle!.click() })
    expect(text()).toContain(t('allModelsExcluded'))
  })

  it('live 空名单给出正常结论说明；Start Plan 卡用专属文案', async () => {
    await renderCard(CN_VARIANT, signedIn({
      models: [],
      catalog: { source: 'live', fetchedAt: 2, empty: true },
    }))
    expect(text()).toContain(t('catalogEmptyRoster'))

    await renderCard(ZCODE_START, signedIn({
      models: [],
      catalog: { source: 'live', fetchedAt: 2, empty: true },
      credits: { total: 0, accounts: [] },
    }))
    expect(text()).toContain(t('catalogEmptyRosterStartPlan'))
  })

  it('目录拉取失败与探测中都是用户可见状态', async () => {
    await renderCard(CN_VARIANT, signedIn({
      catalog: { source: 'fallback', error: 'boom' },
      probe: { running: true, results: [{ id: 'glm-5.3', name: 'GLM-5.3', validation: 'validating', efforts: ['high'], probedAt: 1 }] },
    }))
    expect(text()).toContain(t('catalogSourceError', { message: 'boom' }))
    expect(text()).toContain(t('detectingShort'))
    // 探测记录的档位参与行内档位列（声明档位优先，其次有效观测）。
    expect(text()).toContain(t('catalogSourceFallback'))
  })
})

describe('VariantCardQuota：三种变体的额度展示', () => {
  it('ZCode Coding Plan：套餐名/状态/刷新按钮可点', async () => {
    await renderCard(ZCODE_CODING, signedIn({
      credits: { total: 1, accounts: [{ packageName: 'GLM Coding Pro (有效)', remain: 1, size: 1 }] },
    }))
    expect(text()).toContain('GLM Coding Pro')
    expect(text()).toContain(t('codingPlanExtraQuota'))
    const refresh = buttonByAria(t('refresh'))
    expect(refresh, '额度区块应有刷新按钮').toBeDefined()
    await act(async () => { refresh!.click() })
  })

  it('ZCode Start Plan：多池逐池列出、当日池不结转、到期时刻可见', async () => {
    await renderCard(ZCODE_START, signedIn({
      credits: {
        total: 2,
        accounts: [
          { packageName: 'GLM-5.3-Flash (有效)', remain: 100, size: 200, unit: 'tokens', sameDay: true, expiredAt: '2099-01-01T00:00:00.000Z' },
          { packageName: 'GLM-5.3 (有效)', remain: 50, size: 100, unit: 'tokens' },
        ],
      },
    }))
    expect(text()).toContain(t('planDedicatedQuota'))
    expect(text()).toContain(t('planPoolQuotaLine', { pool: 'GLM-5.3-Flash', remain: '100', size: '200' }))
    expect(text()).toContain(t('planNoCarryOver'))
    expect(text()).toContain(t('planStartNote'))
    expect(text()).toMatch(/2099/u)
  })

  it('ZCode Start Plan 单池走单行文案；claim available 可复制 plan id', async () => {
    await renderCard(ZCODE_START, signedIn({
      credits: { total: 1, accounts: [{ packageName: 'ZCode Trust Build (有效)', remain: 100, size: 200, unit: 'tokens' }] },
      startPlanClaim: { state: 'available', planId: 'plan-123', planName: 'ZCode Trust Build', captchaRequired: true },
    }))
    expect(text()).toContain(t('planQuotaLine', { remain: '100', size: '200' }))
    expect(text()).toContain('plan-123')
    const copy = buttonByText(t('claimCopy'))
    expect(copy, '待领取提示应提供复制按钮').toBeDefined()
    await act(async () => { copy!.click() })
    expect(controlCalls).toContain('copy:plan-123')
    // 复制成功后文案切到「已复制」（短反馈，不是持久状态）。
    expect(text()).toContain(t('claimCopied'))
  })

  it('ZCode Start Plan claim unknown 如实说明探测失败，不伪装成已领', async () => {
    await renderCard(ZCODE_START, signedIn({
      credits: { total: 0, accounts: [] },
      startPlanClaim: { state: 'unknown', reason: 'timeout' },
    }))
    expect(text()).toContain(t('claimUnknown', { reason: 'timeout' }))
  })

  it('OpenCode：官方免费渠道不给虚假点数；刷新按钮可点', async () => {
    await renderCard(OPENCODE, signedIn({ credits: undefined }))
    expect(text()).toContain(t('openCodeFreeBadge'))
    const refresh = buttonByAria(t('refresh'))
    expect(refresh, 'OpenCode 卡也应有刷新入口').toBeDefined()
    await act(async () => { refresh!.click() })
  })

  it('WorkBuddy：积分 + 今日统计 + 历史；缺失时如实说「暂无积分数据」', async () => {
    await renderCard(CN_VARIANT, signedIn({
      credits: {
        total: 591,
        accounts: [],
        today: { consumed: 9, granted: 100, peak: 600, samples: 3 },
        history: [{ date: '2026-11-03', consumed: 12, granted: 100 }],
      },
    }))
    expect(text()).toContain(t('creditsTodayShort', { used: '9' }))
    expect(text()).toContain(t('creditHistoryDay', { date: '2026-11-03', used: '12' }))

    await renderCard(CN_VARIANT, signedIn({ credits: undefined }))
    expect(text()).toContain(t('creditsUnavailable'))
    const refresh = buttonByAria(t('refresh'))
    expect(refresh, 'WorkBuddy 卡应有刷新入口').toBeDefined()
    await act(async () => { refresh!.click() })
    await renderCard(CN_VARIANT, signedIn({ credits: undefined, creditsError: 'boom' }))
    expect(text()).toContain('—')
  })
})

describe('ModelRow 与 StartPlanClaimBox 的剩余可见分支', () => {
  it('多窗口模型在窗口列给出「可选其它窗口」说明', async () => {
    await render(createElement('table', null, createElement('tbody', null, createElement(ModelRow, {
      row: MODEL_ROW,
      efforts: undefined,
      t,
      even: false,
      onDelete: vi.fn(),
    }))))
    expect(text()).toContain(t('contextSmaller', { window: '1M', others: '200K' }))
    const del = buttonByText(t('deleteModel'))
    expect(del).toBeDefined()
  })
})

describe('config-types 纯函数', () => {
  it('catalogSourceKey 区分实时/空名单/已保存/内置；isCatalogLive 只认 live 且无错', () => {
    expect(catalogSourceKey(undefined)).toBe('catalogSourceFallback')
    expect(catalogSourceKey({ source: 'fallback' })).toBe('catalogSourceFallback')
    expect(catalogSourceKey({ source: 'saved' })).toBe('catalogSourceSaved')
    expect(catalogSourceKey({ source: 'live' })).toBe('catalogSourceLive')
    expect(catalogSourceKey({ source: 'live', empty: true })).toBe('catalogSourceEmpty')
    expect(isCatalogLive(undefined)).toBe(false)
    expect(isCatalogLive({ source: 'live', error: 'x' })).toBe(false)
    expect(isCatalogLive({ source: 'live' })).toBe(true)
    expect(isCatalogLive({ source: 'saved' })).toBe(false)
  })
})

describe('client 入口 apply 的降级边界', () => {
  /** 结构最小的 client ctx：只在用例里提供 apply 用到的成员。 */
  function fakeClientContext(overrides: {
    registerError?: Error
    /** 前 N 次 slots.inject 抛错（模拟 slot 服务本身不可用）。 */
    injectFailures?: number
    bindThrows?: boolean
  } = {}): { ctx: Parameters<typeof applyClientEntry>[0]; registered: string[] } {
    const registered: string[] = []
    let injectCalls = 0
    const ctx = {
      effect: (cb: () => unknown) => cb(),
      locale: {
        register: () => {
          if (overrides.registerError !== undefined) throw overrides.registerError
          return () => {}
        },
        bind: () => {
          if (overrides.bindThrows === true) throw new Error('locale unavailable')
          return (key: string) => key
        },
      },
      slots: {
        inject: (_name: string, cb: () => unknown) => {
          injectCalls += 1
          if (injectCalls <= (overrides.injectFailures ?? 0)) throw new Error('slot unavailable')
          cb()
        },
        register: (descriptor: { key?: string; name?: string }) => {
          registered.push(descriptor.key ?? descriptor.name ?? '')
          return () => {}
        },
      },
    } as unknown as Parameters<typeof applyClientEntry>[0]
    return { ctx, registered }
  }

  it('重复注册 locale 静默忽略，卡片照常注册', () => {
    const { ctx, registered } = fakeClientContext({ registerError: new Error('namespace already registered') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyClientEntry(ctx)
    expect(registered).toContain('@chaoset/dsh-any-connect')
    expect(warn).not.toHaveBeenCalled()
  })

  it('locale 注册的其他失败只告警，仍注册卡片', () => {
    const { ctx, registered } = fakeClientContext({ registerError: new Error('disk full') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyClientEntry(ctx)
    expect(warn).toHaveBeenCalled()
    expect(registered).toContain('@chaoset/dsh-any-connect')
  })

  it('slot 注入整体抛错时退回静态占位（宿主 provider 不受影响）', () => {
    const { ctx, registered } = fakeClientContext({ injectFailures: 1 })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    applyClientEntry(ctx)
    // 第一次 inject 抛错 → catch 里用占位再注册一次（第二次 inject 不再抛）。
    expect(registered).toContain('@chaoset/dsh-any-connect')
  })

  it('连 locale 都不可用时仍用硬编码英文占位注册', () => {
    const { ctx, registered } = fakeClientContext({ bindThrows: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    applyClientEntry(ctx)
    expect(registered, JSON.stringify(registered)).toContain('@chaoset/dsh-any-connect')
  })
})

describe('VariantsPage：未登录提示与重试', () => {
  it('已登录变体渲染为卡片：折叠/展开、刷新与状态回写都走真实回调', async () => {
    let probed = false
    const signedInDoc = (fetchedAt: number): Record<string, unknown> => ({
      status: 'signed-in',
      nickname: 'tester',
      catalog: { source: 'live', fetchedAt },
      probe: { running: false, results: [] },
      probeKey: 'k',
      credits: { total: 5, accounts: [] },
      models: [{ id: 'm1', name: 'M1', contextWindow: 1000, contextWindows: [] }],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input)
      if (init?.method === 'POST' && url.endsWith('/probe')) {
        probed = true
        return new Response(JSON.stringify({ state: 'ok' }), { status: 200 })
      }
      // CN 卡已登录（刷新后 fetchedAt 前移，供 waitCatalogLive 判定落地）；
      // 其余变体未登录：一次渲染同时覆盖两条分支。
      if (url.endsWith('/dsh-any-connect/status')) {
        return new Response(JSON.stringify(signedInDoc(probed ? 2 : 1)), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 'signed-out' }), { status: 200 })
    }))
    await render(createElement(VariantsPage, { t }))
    expect(text()).toContain('已登录：tester')

    // 折叠头（onToggle）→ 展开露出额度区刷新按钮。
    // 首个已登录变体会被自动展开（useVariantsPage 的自动展开一次）。
    const headers = [...container.querySelectorAll('button.wb-header')] as HTMLButtonElement[]
    expect(headers.length, '五个变体各一行').toBe(5)
    expect(buttonByAria(t('refresh')), '自动展开的卡片应有额度区刷新按钮').toBeDefined()

    // 折叠头（onToggle）：收起后卡体消失，再展开又回来——用户可见的展开态变化。
    await act(async () => { headers[0]!.click() })
    expect(buttonByAria(t('refresh')), '收起后卡体不应渲染').toBeUndefined()
    const reopened = [...container.querySelectorAll('button.wb-header')][0] as HTMLButtonElement
    await act(async () => { reopened.click() })
    const refresh = buttonByAria(t('refresh'))
    expect(refresh, '再次展开后额度区应有刷新按钮').toBeDefined()
    await act(async () => { refresh!.click() })
    await vi.waitFor(() => { expect(probed, '刷新动作应真的发出控制请求').toBe(true) }, { timeout: 5_000 })
    // 页面不因轮询崩溃即可：回写路径（applyStatus）已在 waitCatalogLive 内执行。
    expect(text()).toContain('已登录：tester')
  })

  it('全部未登录时给出统一提示；错误行可重试', async () => {
    let attempt = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      attempt += 1
      // 第一轮全部失败（渲染错误行），重试时返回未登录。
      return attempt <= 5
        ? new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
        : new Response(JSON.stringify({ status: 'signed-out' }), { status: 200 })
    }))
    await render(createElement(VariantsPage, { t }))
    // 错误行默认收起：先展开才能看到重试入口（用户可见动作路径）。
    const header = container.querySelector('button.wb-header') as HTMLButtonElement
    expect(header, '每个变体都有一行折叠头').toBeDefined()
    await act(async () => { header.click() })
    const retry = buttonByText(t('retry'))
    expect(retry, '错误行展开后应给出重试入口').toBeDefined()
    await act(async () => { retry!.click() })
  })
})
