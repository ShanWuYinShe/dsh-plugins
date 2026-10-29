// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ProviderUsagePill } from '../client/ProviderUsagePill.js'
import type { ProviderUsagePillProps } from '../client/pill-types.js'
import type { ProviderUsageLocaleKey } from '../client/locales.js'
import type { SnapshotAnswer } from '../client/fetch-snapshot.js'

/**
 * 面板焦点管理与手动刷新回归：面板挂着 role="dialog" 就必须可进入——打开移焦
 * 进面板（键盘用户才能读到可滚内容），Esc 关闭归还触发按钮。
 *
 * 额度数据由 resources 的 live 流交付（useResource 桩）；面板刷新按钮是流之外
 * 唯一的手动入口，走 force fetch 直达宿主 registry，本文件只断言这条交互链。
 */

const t = (key: ProviderUsageLocaleKey): string => key

const snapshot = {
  current: { provider: 'deepseek' },
  routable: true,
  groups: [],
  failures: [],
  status: 'ready',
  error: null,
} as unknown as ModelDirectoryState

const directory = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
}

const goodSnapshot: SnapshotAnswer = {
  provider: 'deepseek',
  windows: [{ id: 'w', label: 'W', remain: 3, limit: 10, unit: 'credits' }],
  fetchedAt: 1,
}

function propsWith(answer: SnapshotAnswer): ProviderUsagePillProps {
  return {
    t,
    sessionId: 'session-1',
    resolveSeat: () => ({ directory, load: () => {} }),
    useResource: () => ({ status: 'live', value: answer, failure: undefined }),
  } as unknown as ProviderUsagePillProps
}

const PROPS = propsWith(goodSnapshot)

let root: Root | null = null
let container: HTMLDivElement

beforeEach(() => {
  // React 19 只在显式开启时把 act 内的状态更新当作批处理边界（同 config-page.test.ts）。
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ snapshots: [] }),
  }) as unknown as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

describe('ProviderUsagePill 焦点管理', () => {
  it('打开面板移焦进面板，Esc 关闭归还触发按钮', async () => {
    await act(async () => {
      root!.render(createElement(ProviderUsagePill, PROPS))
    })
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    await act(async () => {
      button!.click()
    })
    const panel = container.querySelector('[role="dialog"]') as HTMLElement | null
    expect(panel).not.toBeNull()
    expect(document.activeElement).toBe(panel)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(button)
  })
})

describe('ProviderUsagePill 刷新与过期', () => {
  async function openPanel(props: ProviderUsagePillProps = PROPS): Promise<HTMLButtonElement> {
    await act(async () => {
      root!.render(createElement(ProviderUsagePill, props))
    })
    const button = container.querySelector('.pu-pill-btn') as HTMLButtonElement
    await act(async () => {
      button.click()
    })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    return button
  }

  function refreshButton(): HTMLButtonElement {
    const found = [...container.querySelectorAll('.pu-pill-panel button')]
      .find(button => button.textContent === 'refresh')
    if (found === undefined) throw new Error('refresh button not rendered')
    return found as HTMLButtonElement
  }

  it('面板刷新按钮会 force 重新请求（live 流之外的主动入口）', async () => {
    const calls: string[] = []
    const refreshed: SnapshotAnswer = {
      provider: 'deepseek',
      windows: [{ id: 'w', label: 'W', remain: 8, limit: 10, unit: 'credits' }],
      fetchedAt: 2,
    }
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return { ok: true, json: async () => ({ snapshots: [refreshed] }) } as unknown as Response
    }))
    const button = await openPanel()
    // 流已交付首帧，组件本身不再自动 fetch。
    expect(calls).toHaveLength(0)
    await act(async () => {
      refreshButton().click()
    })
    expect(calls.length).toBeGreaterThan(0)
    // force 走刷新参数，而不是吃宿主缓存。
    expect(calls[0]).toContain('refresh=1')
    expect(button.textContent).toContain('8')
  })

  it('失败保旧值时标过期：圆点降饱和 + 文案后缀', async () => {
    let fail = false
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (fail) throw new Error('upstream down')
      return { ok: true, json: async () => ({ snapshots: [goodSnapshot] }) } as unknown as Response
    }))
    const button = await openPanel()
    expect(button.getAttribute('aria-label')).not.toContain('staleData')
    fail = true
    await act(async () => {
      refreshButton().click()
    })
    // 旧值保留（headline 还是 3 credits，来自 live 流），但标了过期。
    expect(button.getAttribute('aria-label')).toContain('staleData')
    expect(button.textContent).toContain('3')
  })

  it('点击刷新时按钮文案保持稳定且无突兀插行，弹窗尺寸稳定零抖动', async () => {
    let finishFetch: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      finishFetch = () => resolve({ ok: true, json: async () => ({ snapshots: [goodSnapshot] }) } as unknown as Response)
    })))
    await openPanel()
    const panel = container.querySelector('[role="dialog"]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.style.width).toBe('310px')

    const btn = refreshButton()
    expect(btn.textContent).toBe('refresh')
    expect(btn.querySelector('svg')).not.toBeNull()

    // 触发刷新（异步挂起进入 busy 态）
    await act(async () => {
      btn.click()
    })

    // busy 状态下：
    // 1. 按钮文字仍然是 refresh，防止替换成 refreshing 导致按钮拉伸变形
    expect(btn.textContent).toBe('refresh')
    // 2. 按钮处于禁用态且 svg 带有旋转动画类名
    expect(btn.disabled).toBe(true)
    expect(btn.querySelector('svg')?.getAttribute('class')).toContain('pu-spin-icon')
    // 3. 正文区域没有插入独立的 refreshing 段落导致高度突然撑大跳动
    const paragraphs = [...panel.querySelectorAll('p')].map(p => p.textContent)
    expect(paragraphs).not.toContain('refreshing')

    // 结束 fetch
    await act(async () => {
      finishFetch?.()
    })
    expect(btn.disabled).toBe(false)
  })

  it('触发按钮靠右缘时面板右对齐（防溢出视口）', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 300, configurable: true })
    try {
      await openPanel()
      const panel = container.querySelector('[role="dialog"]') as HTMLElement
      // getBoundingClientRect 在 jsdom 里全零：left(0)+320 > 300-8 即翻转。
      expect(panel.style.right).toBe('0px')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    }
  })
})
