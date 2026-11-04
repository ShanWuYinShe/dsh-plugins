// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRow } from '../client/ModelRow.tsx'
import { VariantCard } from '../client/VariantCard.tsx'
import { WorkBuddyConfigPage } from '../client/WorkBuddyConfigPage.tsx'
import type { WorkBuddyConfigPageInjected, WorkBuddyConfigPageProps, WorkBuddyCardVariant, CardStatus } from '../client/config-types.ts'
import { CARD_VARIANTS } from '../client/config-types.ts'
import { zh } from '../client/locales.ts'
import type { WorkBuddyWebModelRow, WorkBuddyWebStatus } from '../src/status-paths.ts'

/**
 * 组件 props 直喂 jsdom 回归（RULE-087）：真实组件 + 真实 props/fixture + 真实
 * zh 文案字典，断言**用户可见行为**（徽标文案、错误行、按钮动作、展开态），
 * 不断言 class / 元素树内部结构 / 内联样式。
 *
 * 与 config-page.test.ts 的分工：那边测整页的数据流（fetch → 卡片），这里测
 * 单个展示组件在给定 props 下的渲染契约——两者都走真实字典，缺 key/文案漂移
 * 会在这两个文件里红灯。
 */

/** 真实 zh 字典 + 插值（与 config-page.test.ts 同一口径）。 */
const t: WorkBuddyConfigPageInjected['t'] = (key, params) => {
  let out: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) out = out.replace(`{${name}}`, String(value))
  return out
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element)
    // 让挂载 effect / 首帧微任务落定（组件本身是同步渲染，这里只是防御）。
    await Promise.resolve()
  })
}

function text(): string {
  return container.textContent ?? ''
}

/** 找用户可点的按钮（按可见文案，不按 class）。 */
function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label) as HTMLButtonElement | undefined
}

const MODEL_ROW: WorkBuddyWebModelRow = {
  id: 'glm-5.3',
  name: 'GLM-5.3',
  contextWindow: 1_000_000,
  contextWindows: [1_000_000],
  free: false,
  credits: 'x0.79',
}

describe('ModelRow：行内可见事实与动作', () => {
  it('免费行显示本地化「免费」徽标、不显示倍率；重复 badge 只出现一次', async () => {
    await render(createElement(
      'table',
      null,
      createElement('tbody', null, createElement(ModelRow, {
        row: { ...MODEL_ROW, id: 'free', name: 'FreeModel', free: true, credits: undefined, badges: ['夜间折扣', '夜间折扣'] },
        efforts: ['low', 'high'],
        t,
        even: false,
      })),
    ))
    // 免费信息是 badge 的职责：行内显示本地化文案「免费」。
    expect(text()).toContain(zh.freeModel)
    // 倍率列对免费行留空（倍率由 name 后缀承载，不在表格里重复）。
    expect(text()).not.toContain('x0.00')
    // badge 去重后按身份渲染：同一个徽标文案只出现一次（不因重复源数据出现两遍）。
    expect(text().split(zh.badgeNightDiscount).length - 1).toBe(1)
    // 档位是用户可见事实：声明的档位原样列出。
    expect(text()).toContain('low/high')
  })

  it('价格未知行给出「价格未知」+ 刷新按钮；点击触发刷新动作', async () => {
    const onRefresh = vi.fn()
    await render(createElement(
      'table',
      null,
      createElement('tbody', null, createElement(ModelRow, {
        row: { ...MODEL_ROW, id: 'unknown', name: 'Unknown', credits: undefined, rateUnknown: true },
        efforts: undefined,
        t,
        even: true,
        onRefresh,
      })),
    ))
    expect(text()).toContain(zh.rateUnknown)
    const refresh = button(zh.refresh)
    expect(refresh, '价格未知行应就地给出刷新入口').toBeDefined()
    await act(async () => { refresh!.click() })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('隐藏区行只给「恢复」动作，点击回传的是这一行的 id', async () => {
    const onRestore = vi.fn()
    await render(createElement(
      'table',
      null,
      createElement('tbody', null, createElement(ModelRow, {
        row: { ...MODEL_ROW, id: 'hidden-model', name: 'Hidden' },
        efforts: undefined,
        t,
        even: false,
        onRestore,
      })),
    ))
    expect(button(zh.deleteModel), '隐藏行不应出现删除动作').toBeUndefined()
    const restore = button(zh.restoreModel)
    expect(restore, '隐藏区每行都必须有自己的恢复按钮').toBeDefined()
    await act(async () => { restore!.click() })
    expect(onRestore).toHaveBeenCalledWith('hidden-model')
  })
})

/** 一份已登录状态文档（形状同 web-status 输出；只填本组用例关心的字段）。 */
function signedInStatus(overrides: Partial<Extract<WorkBuddyWebStatus, { status: 'signed-in' }>> = {}): Extract<CardStatus, { status: 'signed-in' }> {
  return {
    status: 'signed-in',
    nickname: 'tester',
    domain: 'www.codebuddy.cn',
    catalog: { source: 'live', fetchedAt: 1 },
    probe: { running: false, results: [] },
    probeKey: 'test-probe-key',
    credits: { total: 591, accounts: [{ packageName: '裂变包', remain: 591, size: 600 }] },
    models: [
      { id: 'auto', name: 'Auto', contextWindow: 256_000, contextWindows: [] },
      { id: 'glm-5.3', name: 'GLM-5.3 · x0.79', contextWindow: 1_000_000, contextWindows: [], credits: 'x0.79' },
    ],
    ...overrides,
  } as Extract<CardStatus, { status: 'signed-in' }>
}

const CARD_VARIANT: WorkBuddyCardVariant = CARD_VARIANTS[0]!

async function renderCard(status: Extract<CardStatus, { status: 'signed-in' }>, open: boolean): Promise<void> {
  await render(createElement(VariantCard, {
    t,
    variant: CARD_VARIANT,
    status,
    open,
    onToggle: vi.fn(),
    fetchStatus: async () => status,
    applyStatus: vi.fn(),
  }))
}

describe('VariantCard：真实 status 文档直喂', () => {
  it('展开态卡头给出身份与当前积分，卡体渲染模型折叠入口', async () => {
    await renderCard(signedInStatus(), true)
    const header = [...container.querySelectorAll('button')]
      .find(candidate => (candidate.getAttribute('aria-label') ?? '').startsWith(zh.collapse))
    expect(header, '展开态卡头按钮应带收起 aria-label').toBeDefined()
    expect(header!.getAttribute('aria-expanded')).toBe('true')
    expect(text(), '卡头应显示已登录身份').toContain('已登录：tester')
    expect(text(), '卡头应显示当前积分').toContain('当前积分 591')
    // 模型清单默认收起，入口显示真实模型数。
    expect(text()).toContain('模型 · 2')
  })

  it('creditsError 作为用户可见错误行渲染；收起态不渲染卡体', async () => {
    await renderCard(signedInStatus({ creditsError: 'upstream down' }), true)
    expect(text(), '额度查询失败必须可见').toContain('积分查询失败：upstream down')

    await renderCard(signedInStatus(), false)
    expect(text(), '收起态不渲染卡体（模型入口消失）').not.toContain('模型 · 2')
  })
})

describe('WorkBuddyConfigPage：缺注入时的降级', () => {
  it('缺 t 时不抛错、渲染为空（由宿主边界兜住，而不是炸整页）', async () => {
    const props = { t: undefined, view: 'page' } as unknown as WorkBuddyConfigPageProps
    await render(createElement(WorkBuddyConfigPage, props))
    expect(text()).toBe('')
  })
})
