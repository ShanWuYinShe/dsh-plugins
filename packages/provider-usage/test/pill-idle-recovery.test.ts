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
 * 会话长期搁置与唤醒恢复回归（夜间完成任务长期搁置后第二天额度丢失缺陷）。
 *
 * 缺陷成因：
 * 1. 会话长期搁置或宿主重连（connection/reset）导致 ModelDirectory 的 current 变为 null；
 * 2. 旧实现只在 mount 调一次 load，此后 current 为 null 时既不重试 load，
 *    也将 provider 判定为 undefined 直接 return null 卸载 pill；
 * 3. 轮询与 visibilitychange 监听被 if (!provider) return 整个跳过，唤醒无法重拉；
 * 4. 修复后：
 *    - current 为 null 且不在 loading/error 时自动调 load()；
 *    - current 暂时变 null 时保持最近一次已知 provider，DOM 不卸载，保留旧值并标记过期；
 *    - 维持 60s 轮询与 visibilitychange/focus/online 唤醒监听，唤醒时 current 为 null 调 load，有 provider 调 refresh；
 *    - current 从 null 恢复到有值时立即重拉 refresh() 并消除过期状态。
 */

const t = (key: ProviderUsageLocaleKey): string => key

interface MutableStore {
  subscribe: (fn: () => void) => () => void
  getSnapshot: () => ModelDirectoryState
  set: (next: ModelDirectoryState) => void
}

function makeMutableDirectory(initial: ModelDirectoryState, onLoad?: () => void): {
  directory: MutableStore
  load: () => void
  loadCalls: () => number
} {
  let currentSnapshot = initial
  const listeners = new Set<() => void>()
  let loads = 0

  const store: MutableStore = {
    subscribe: (fn) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    getSnapshot: () => currentSnapshot,
    set: (next) => {
      currentSnapshot = next
      for (const fn of listeners) fn()
    },
  }

  const load = () => {
    loads += 1
    onLoad?.()
  }

  return {
    directory: store,
    load,
    loadCalls: () => loads,
  }
}

const readyDeepseek: ModelDirectoryState = {
  current: { provider: 'deepseek', model: 'deepseek-chat' } as any,
  pending: null,
  routable: true,
  groups: [],
  failures: [],
  status: 'ready',
  error: null,
}

const nullIdle: ModelDirectoryState = {
  current: null,
  pending: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

const goodSnapshot = {
  provider: 'deepseek',
  windows: [{ id: 'w1', label: 'Credits', remain: 42, limit: 100, unit: 'CNY' }],
  fetchedAt: Date.now(),
}

let root: Root | null = null
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ snapshots: [goodSnapshot] }),
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

describe('ProviderUsagePill 长期搁置与重连唤醒恢复', () => {
  it('挂载时 current 为 null：自动触发 load()，目录就绪后正常渲染额度', async () => {
    let loaded = false
    const { directory, load, loadCalls } = makeMutableDirectory(nullIdle, () => {
      loaded = true
    })

    await act(async () => {
      root!.render(createElement(ProviderUsagePill, { t, directory, load } as unknown as ProviderUsagePillProps))
    })

    // 挂载时 current 为 null，必须触发 load()
    expect(loadCalls()).toBe(1)
    expect(loaded).toBe(true)

    // 此时尚未就绪，无历史 provider，渲染 null
    expect(container.querySelector('.pu-pill-btn')).toBeNull()

    // 目录装载完成，切为 readyDeepseek
    await act(async () => {
      directory.set(readyDeepseek)
    })

    // pill 成功长出并展示 DeepSeek 额度
    const button = container.querySelector('.pu-pill-btn')
    expect(button).not.toBeNull()
    expect(button!.textContent).toContain('deepseek')
    expect(button!.textContent).toContain('42')
  })

  it('会话搁置后 current 被置空：保留旧值并标过期，不从 DOM 闪烁卸载，并自动请求 load()', async () => {
    const { directory, load, loadCalls } = makeMutableDirectory(readyDeepseek)

    await act(async () => {
      root!.render(createElement(ProviderUsagePill, { t, directory, load } as unknown as ProviderUsagePillProps))
    })

    const button = container.querySelector('.pu-pill-btn') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.textContent).toContain('42')
    const initialLoads = loadCalls()

    // 模拟夜间搁置 / 宿主重连：目录被清空为 nullIdle
    await act(async () => {
      directory.set(nullIdle)
    })

    // 断言 1：pill 不被卸载，旧数字仍然可见
    const buttonAfterNull = container.querySelector('.pu-pill-btn') as HTMLButtonElement
    expect(buttonAfterNull).not.toBeNull()
    expect(buttonAfterNull.textContent).toContain('42')

    // 断言 2：标为过期状态（提示用户当前显示的是断连前的旧数据）
    expect(buttonAfterNull.getAttribute('aria-label')).toContain('staleData')

    // 断言 3：自动重新触发 load()
    expect(loadCalls()).toBeGreaterThan(initialLoads)
  })

  it('current 从 null 恢复到有值时：立即重新拉取额度并消除过期状态', async () => {
    const { directory, load } = makeMutableDirectory(readyDeepseek)

    await act(async () => {
      root!.render(createElement(ProviderUsagePill, { t, directory, load } as unknown as ProviderUsagePillProps))
    })

    const button = container.querySelector('.pu-pill-btn') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).not.toContain('staleData')

    // 置空
    await act(async () => {
      directory.set(nullIdle)
    })
    expect(button.getAttribute('aria-label')).toContain('staleData')

    // 新快照返回更新后的额度 88
    const updatedSnapshot = {
      provider: 'deepseek',
      windows: [{ id: 'w1', label: 'Credits', remain: 88, limit: 100, unit: 'CNY' }],
      fetchedAt: Date.now(),
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ snapshots: [updatedSnapshot] }),
    }) as unknown as Response))

    // 目录恢复就绪
    await act(async () => {
      directory.set(readyDeepseek)
    })

    // 额度刷新为 88，过期标记消除
    expect(button.textContent).toContain('88')
    expect(button.getAttribute('aria-label')).not.toContain('staleData')
  })

  it('页面唤醒（visibilitychange / focus / online）：若处于断开态自动重试 load()，否则触发 refresh()', async () => {
    const { directory, load, loadCalls } = makeMutableDirectory(nullIdle)

    await act(async () => {
      root!.render(createElement(ProviderUsagePill, { t, directory, load } as unknown as ProviderUsagePillProps))
    })
    const loadsBefore = loadCalls()

    // 模拟早上切回标签页（visibilitychange）
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(loadCalls(), '断开态下唤醒必须重试 load()').toBeGreaterThan(loadsBefore)

    // 目录恢复
    await act(async () => {
      directory.set(readyDeepseek)
    })

    // 正常态下 window focus 唤醒应发起 refresh
    const fetchCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      fetchCalls.push(String(input))
      return { ok: true, json: async () => ({ snapshots: [goodSnapshot] }) } as unknown as Response
    }))
    const beforeFocusFetch = fetchCalls.length
    await new Promise(resolve => setTimeout(resolve, 1100)) // 绕过 1s 防抖
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(fetchCalls.length, '就绪态下唤醒必须触发额度刷新').toBeGreaterThan(beforeFocusFetch)
  })

  it('同 provider 的重连抖动不抹除答案，真实 provider 切换时才清空答案', async () => {
    const { directory, load } = makeMutableDirectory(readyDeepseek)

    await act(async () => {
      root!.render(createElement(ProviderUsagePill, { t, directory, load } as unknown as ProviderUsagePillProps))
    })
    const button = container.querySelector('.pu-pill-btn') as HTMLButtonElement
    expect(button.textContent).toContain('42')

    // 抖动为 null 后恢复回 deepseek：旧数字不被置为 loading 骨架
    await act(async () => {
      directory.set(nullIdle)
    })
    expect(button.textContent).toContain('42')

    await act(async () => {
      directory.set(readyDeepseek)
    })
    expect(button.textContent).toContain('42')

    // 真实切换为 minimax
    const readyMinimax: ModelDirectoryState = {
      current: { provider: 'minimax', model: 'abab6.5' } as any,
      pending: null,
      routable: true,
      groups: [],
      failures: [],
      status: 'ready',
      error: null,
    }
    // 延迟 minimax 的响应以断言清空行为
    let resolveMinimax: (val: any) => void
    const pendingFetch = new Promise((resolve) => { resolveMinimax = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => pendingFetch as any))

    await act(async () => {
      directory.set(readyMinimax)
    })

    // 真实切换 provider 时，旧 deepseek 的 42 必须被清空，显示 loading / 转圈
    expect(button.textContent).not.toContain('42')
    expect(button.textContent).toContain('minimax')
    expect(button.textContent).toContain('loading')

    // 释放响应
    await act(async () => {
      resolveMinimax!({
        ok: true,
        json: async () => ({ snapshots: [{ provider: 'minimax', windows: [], fetchedAt: Date.now() }] }),
      })
    })
  })
})
