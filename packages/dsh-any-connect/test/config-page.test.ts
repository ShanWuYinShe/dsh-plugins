// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyConfigPage } from '../client/WorkBuddyConfigPage.tsx'
import type { WorkBuddyConfigPageInjected, WorkBuddyConfigPageProps } from '../client/WorkBuddyConfigPage.tsx'
import { zh } from '../client/locales.ts'

/**
 * 配置卡片的渲染回归：卡片常看的只有「这是谁的账号 / 现在还剩多少积分」，
 * 积分由哪些套餐构成（进度条明细）与模型清单都是次要信息——前者不渲染，
 * 后者默认收起、点开才出现。此前卡片把 6 条套餐进度条与 16 行模型全部铺开，
 * 首屏全是用户不关心的组成结构；这组用例把这个口径钉住，避免回潮。
 *
 * 真实组件在 jsdom 里渲染（client 半边的 XHR 用 fetch stub 拦住），文案走
 * 真实的 `zh` 字典，因此缺 key / 文案漂移会在这里红灯。
 */

/** 卡片渲染的整份状态文档：两个套餐 + 两个模型，字段形状同 web-status 输出。 */
const STATUS_DOC = {
  status: 'signed-in',
  nickname: 'tester',
  domain: 'www.codebuddy.cn',
  catalog: { source: 'live', fetchedAt: 1 },
  probe: { running: false, results: [] },
  probeKey: 'test-probe-key',
  credits: {
    total: 591,
    accounts: [
      { packageName: 'CodeBuddy 个人版国内运营裂变包', remain: 91, size: 100 },
      { packageName: 'CodeBuddy 个人版国内运营裂变包', remain: 500, size: 500 },
    ],
  },
  models: [
    { id: 'auto', name: 'Auto', contextWindow: 256000, largerWindows: [] },
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1000000, largerWindows: [], credits: 'x0.79' },
  ],
}

/** 真实的 zh 字典 + 插值，确保断言的是用户实际看到的文案。 */
const t: WorkBuddyConfigPageInjected['t'] = (key, params) => {
  let out: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) out = out.replace(`{${name}}`, String(value))
  return out
}

const PROPS = { t, view: 'page' } as unknown as WorkBuddyConfigPageProps

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // React 19 只在显式开启时把 act 内的状态更新当作批处理边界。
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // 各变体拉取 status：默认国内版返回已登录文档，国际版与 ZCode 返回未登录。
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/ai/') || url.includes('/zcode/')) {
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    }
    return { ok: true, status: 200, json: async () => STATUS_DOC }
  }))
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

/** 挂载 + 等首拉落定（fetch 的两次 await 之外再让出一拍宏任务）。 */
async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkBuddyConfigPage, PROPS))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function text(): string {
  return container.textContent ?? ''
}

/** 卡头按钮：唯一带「展开/收起」aria-label 的按钮。 */
function headerButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find(button => (button.getAttribute('aria-label') ?? '').startsWith(zh.collapse))
  if (found === undefined) throw new Error('card header not rendered')
  return found as HTMLButtonElement
}

/** 折叠开关本身不带 aria-label（卡头按钮才有「展开/收起」标签），据此区分两者。 */
function modelToggle(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === null
      && button.textContent?.includes(zh.modelsCount.replace('{n}', '')))
  if (found === undefined) throw new Error('model list toggle not rendered')
  return found as HTMLButtonElement
}

describe('WorkBuddy 配置卡片', () => {
  it('卡头直接给出当前积分（收起态也能看到）', async () => {
    await mount()
    const header = headerButton()
    // 摘要用「当前积分」而不是含糊的「合计」——它就是当前剩余总量。
    expect(header.textContent).toContain('已登录：tester')
    expect(header.textContent).toContain('当前积分 591')
    // 模型数只出现在卡体的折叠开关上，卡头不重复。
    expect(header.textContent).not.toContain('模型 ·')
  })

  it('不再渲染积分套餐明细（进度条与套餐名）', async () => {
    await mount()
    expect(text()).not.toContain('CodeBuddy 个人版国内运营裂变包')
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(0)
    // 卡体的常看信息是积分数字本身（账号身份在卡头摘要里，不再重复）。
    expect(text()).toContain('当前积分')
    expect(text()).toContain('591')
  })

  it('模型清单默认收起，点开后才渲染模型行', async () => {
    await mount()
    expect(text()).not.toContain('GLM-5.3')
    expect(modelToggle().getAttribute('aria-expanded')).toBe('false')

    await act(async () => { modelToggle().click() })
    expect(modelToggle().getAttribute('aria-expanded')).toBe('true')
    expect(text()).toContain('GLM-5.3')
    expect(text()).toContain('x0.79')

    await act(async () => { modelToggle().click() })
    expect(text()).not.toContain('GLM-5.3')
  })

  it('积分查询失败时在卡体如实说明', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => ({
      ok: true,
      status: 200,
      json: async () => String(input).includes('/ai/')
        ? { status: 'signed-out' }
        : { ...STATUS_DOC, credits: undefined, creditsError: 'boom' },
    })))
    await mount()
    expect(text()).toContain('积分查询失败：boom')
    // 积分读不到时卡体不编造数字。
    expect(text()).not.toContain('当前积分 591')
  })

  it('ZCode 卡片渲染 Coding Plan 订阅状态与特权标签而不是模糊的积分', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/zcode/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: 'signed-in',
            nickname: 'zcode-tester',
            credits: {
              total: 1,
              accounts: [
                { packageName: 'GLM Coding Pro (有效)', remain: 1, size: 1, expiredAt: '2026-10-21T00:00:00.000Z' },
              ],
            },
            models: [],
          }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ status: 'signed-out' }) }
    }))
    await mount()
    const content = text()
    expect(content).toContain('GLM Coding Pro · 有效')
    expect(content).toContain('150% 专属额度')
    expect(content).toContain('夜间 23:00~09:00 免费')
    expect(content).not.toContain('当前积分 1')
  })
})
