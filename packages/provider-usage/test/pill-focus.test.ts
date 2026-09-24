// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ProviderUsagePill } from '../client/ProviderUsagePill.js'
import type { ProviderUsagePillProps } from '../client/ProviderUsagePill.js'
import type { ProviderUsageLocaleKey } from '../client/locales.js'

/**
 * 面板焦点管理回归：面板挂着 role="dialog" 就必须可进入——打开移焦进
 * 面板（键盘用户才能读到可滚内容），Esc 关闭归还触发按钮。真组件在
 * jsdom 里渲染，fetch 用桩拦住（答案内容与焦点断言无关）。
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

const PROPS = { t, directory } as unknown as ProviderUsagePillProps

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
  const goodSnapshot = {
    provider: 'deepseek',
    windows: [{ id: 'w', label: 'W', remain: 3, limit: 10, unit: 'credits' }],
    fetchedAt: 1,
  }

  async function openPanel(): Promise<HTMLButtonElement> {
    await act(async () => {
      root!.render(createElement(ProviderUsagePill, PROPS))
    })
    // 首答落地（mount 触发一次 refresh）。
    await act(async () => {})
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

  it('面板刷新按钮会重新请求（60s 轮询之外的主动入口）', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return { ok: true, json: async () => ({ snapshots: [goodSnapshot] }) } as unknown as Response
    }))
    await openPanel()
    const before = calls.length
    expect(before).toBeGreaterThan(0)
    await act(async () => {
      refreshButton().click()
    })
    expect(calls.length).toBeGreaterThan(before)
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
    // 旧值保留（ headline 还是 3 credits），但标了过期。
    expect(button.getAttribute('aria-label')).toContain('staleData')
    expect(button.textContent).toContain('3')
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
