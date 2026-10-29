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
import { usageResourceAddress } from '../client/resource-provider.js'

/**
 * 会话长期搁置与重连恢复回归（夜间完成任务长期搁置后第二天额度丢失缺陷）。
 *
 * 额度数据唯一通道是 resources 的 live 流（见 useProviderUsage），本测试用
 * 可控的 useResource 桩驱动资源帧，验证组件的目录/取值协作：
 * 1. 会话长期搁置或宿主重连（connection/reset）导致 ModelDirectory 的 current
 *    变为 null；
 * 2. current 为 null 且不在 loading/error 时自动调 load()；
 * 3. current 暂时变 null 时保持最近一次已知 provider，DOM 不卸载，保留旧值并
 *    标记过期；
 * 4. current 从 null 恢复到有值时消除过期状态，流帧值照常渲染；
 * 5. 同一 provider 的重连抖动不闪白，真实切换 provider 才清空旧答案。
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

/** useResource 桩：按地址保存流帧值，未收到的地址是 loading。 */
interface ResourceProbe {
  status: 'loading' | 'live' | 'failed'
  value: SnapshotAnswer | undefined
  failure: undefined
}

function makeResource(): {
  useResource: (address: string) => ResourceProbe
  set: (address: string, value: SnapshotAnswer) => void
  fail: (address: string) => void
} {
  const values = new Map<string, SnapshotAnswer>()
  const failed = new Set<string>()
  const useResource = (address: string): ResourceProbe => {
    if (failed.has(address)) return { status: 'failed', value: values.get(address), failure: undefined }
    const value = values.get(address)
    return value === undefined
      ? { status: 'loading', value: undefined, failure: undefined }
      : { status: 'live', value, failure: undefined }
  }
  return {
    useResource,
    set: (address, value) => { values.set(address, value) },
    fail: (address) => { failed.add(address) },
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

function snapshotOf(remain: number): SnapshotAnswer {
  return {
    provider: 'deepseek',
    windows: [{ id: 'w1', label: 'Credits', remain, limit: 100, unit: 'CNY' }],
    fetchedAt: Date.now(),
  }
}

let root: Root | null = null
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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

/** 渲染 pill：目录经 resolveSeat 交付（与生产注入面同形），额度经 useResource 流交付。 */
async function renderPill(parts: {
  directory: MutableStore
  load: () => void
  resource: ReturnType<typeof makeResource>
}): Promise<void> {
  const props = {
    t,
    sessionId: 'session-1',
    resolveSeat: () => ({ directory: parts.directory, load: parts.load }),
    useResource: parts.resource.useResource,
  } as unknown as ProviderUsagePillProps
  await act(async () => {
    root!.render(createElement(ProviderUsagePill, props))
  })
}

describe('ProviderUsagePill 长期搁置与重连恢复', () => {
  it('挂载时 current 为 null：自动触发 load()，目录就绪后正常渲染额度', async () => {
    let loaded = false
    const { directory, load, loadCalls } = makeMutableDirectory(nullIdle, () => {
      loaded = true
    })
    const resource = makeResource()

    await renderPill({ directory, load, resource })

    // 挂载时 current 为 null，必须触发 load()
    expect(loadCalls()).toBe(1)
    expect(loaded).toBe(true)

    // 此时尚未就绪，无历史 provider，渲染 null
    expect(container.querySelector('.pu-pill-btn')).toBeNull()

    // 目录装载完成 + 流首帧到达
    resource.set(usageResourceAddress('deepseek'), snapshotOf(42))
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
    const resource = makeResource()
    resource.set(usageResourceAddress('deepseek'), snapshotOf(42))

    await renderPill({ directory, load, resource })

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

  it('current 从 null 恢复到有值时：流帧刷新额度并消除过期状态', async () => {
    const { directory, load } = makeMutableDirectory(readyDeepseek)
    const resource = makeResource()
    resource.set(usageResourceAddress('deepseek'), snapshotOf(42))

    await renderPill({ directory, load, resource })

    const button = container.querySelector('.pu-pill-btn') as HTMLButtonElement
    expect(button).not.toBeNull()
    expect(button.getAttribute('aria-label')).not.toContain('staleData')

    // 置空
    await act(async () => {
      directory.set(nullIdle)
    })
    expect(button.getAttribute('aria-label')).toContain('staleData')

    // 流下一帧带更新后的额度 88，目录恢复就绪
    resource.set(usageResourceAddress('deepseek'), snapshotOf(88))
    await act(async () => {
      directory.set(readyDeepseek)
    })

    // 额度刷新为 88，过期标记消除
    expect(button.textContent).toContain('88')
    expect(button.getAttribute('aria-label')).not.toContain('staleData')
  })

  it('流报 failed（协议异常态）时标过期，旧值仍可见', async () => {
    const { directory, load } = makeMutableDirectory(readyDeepseek)
    const resource = makeResource()
    resource.set(usageResourceAddress('deepseek'), snapshotOf(42))

    await renderPill({ directory, load, resource })
    const button = container.querySelector('.pu-pill-btn') as HTMLButtonElement
    expect(button.getAttribute('aria-label')).not.toContain('staleData')

    resource.fail(usageResourceAddress('deepseek'))
    await act(async () => {
      directory.set({ ...readyDeepseek })
    })

    expect(button.getAttribute('aria-label')).toContain('staleData')
    expect(button.textContent).toContain('42')
  })

  it('同 provider 的重连抖动不抹除答案，真实 provider 切换时才清空答案', async () => {
    const { directory, load } = makeMutableDirectory(readyDeepseek)
    const resource = makeResource()
    resource.set(usageResourceAddress('deepseek'), snapshotOf(42))

    await renderPill({ directory, load, resource })
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

    // 真实切换为 minimax：旧地址的流值不再适用（新地址还在 loading）
    const readyMinimax: ModelDirectoryState = {
      current: { provider: 'minimax', model: 'abab6.5' } as any,
      pending: null,
      routable: true,
      groups: [],
      failures: [],
      status: 'ready',
      error: null,
    }
    await act(async () => {
      directory.set(readyMinimax)
    })

    // 真实切换 provider 时，旧 deepseek 的 42 必须被清空，显示 loading / 转圈
    expect(button.textContent).not.toContain('42')
    expect(button.textContent).toContain('minimax')
    expect(button.textContent).toContain('loading')

    // 新 provider 的流首帧到达后正常展示
    resource.set(usageResourceAddress('minimax'), {
      provider: 'minimax',
      windows: [{ id: 'w1', label: 'Weekly', remain: 7, unit: 'credits' }],
      fetchedAt: Date.now(),
    })
    await act(async () => {
      directory.set({ ...readyMinimax })
    })
    expect(button.textContent).toContain('7')
  })
})
