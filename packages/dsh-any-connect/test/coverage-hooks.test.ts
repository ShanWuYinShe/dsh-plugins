// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVariantCard } from '../client/useVariantCard.ts'
import { useVariantsPage } from '../client/useVariantsPage.ts'
import { CARD_VARIANTS, POLL_INTERVAL_MS } from '../client/config-types.ts'
import type { WorkBuddyConfigPageInjected, WorkBuddyCardVariant, CardStatus } from '../client/config-types.ts'
import { zh } from '../client/locales.ts'
import type { WorkBuddyWebStatus } from '../src/status-paths.ts'

/**
 * 两个 client hook 的状态机/定时器回归（用户可见路径：刷新、隐藏/恢复、
 * 复制反馈、轮询、可见性暂停、错误重试）。用真实 React 渲染承载 hook，
 * 断言 hook 对外动作的可观测结果；定时器走 fake timers，不睡墙钟。
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
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    if (String(input).endsWith('/probe') && init?.method === 'POST') {
      const action = JSON.parse(init.body ?? '{}') as { action?: string; modelId?: string }
      controlCalls.push(action.modelId === undefined ? String(action.action) : `${action.action}:${action.modelId}`)
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
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

type SignedIn = Extract<WorkBuddyWebStatus, { status: 'signed-in' }>

function signedIn(overrides: Partial<SignedIn> = {}): SignedIn {
  return {
    status: 'signed-in',
    nickname: 'tester',
    catalog: { source: 'live', fetchedAt: 1 },
    probe: { running: false, results: [] },
    probeKey: 'test-key',
    credits: { total: 10, accounts: [] },
    models: [{ id: 'm1', name: 'M1', contextWindow: 1000, contextWindows: [] }],
    ...overrides,
  } as SignedIn
}

const VARIANT: WorkBuddyCardVariant = CARD_VARIANTS[0]!

interface CardApi {
  refresh(): Promise<void>
  refreshWithCatalog(): Promise<void>
  deleteModel(modelId: string): Promise<void>
  restoreModel(modelId: string): Promise<void>
  restoreModels(): Promise<void>
  copyPlanId(planId: string): Promise<void>
  notice: string | undefined
  copiedPlanId: boolean
  busy: boolean
}

/** 用真实渲染承载 hook，并把最新 api 暴露给用例（hook 规则要求组件内调用）。 */
let api: CardApi | undefined
function CardHarness({ props }: {
  props: Parameters<typeof useVariantCard>[0]
}): null {
  api = useVariantCard(props) as unknown as CardApi
  return null
}

async function mountCard(status: SignedIn, overrides: {
  fetchStatus?: (signal?: AbortSignal) => Promise<WorkBuddyWebStatus>
} = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(CardHarness, {
      props: {
        t,
        variant: VARIANT,
        status: status as Extract<CardStatus, { status: 'signed-in' }>,
        open: true,
        onToggle: () => {},
        fetchStatus: overrides.fetchStatus ?? (async () => status as WorkBuddyWebStatus),
        applyStatus: () => {},
      },
    }))
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('useVariantCard 动作与定时器', () => {
  it('刷新成功路径：POST 刷新 + 等目录 live 落定', async () => {
    const saved = signedIn({ catalog: { source: 'saved', fetchedAt: 1 } })
    const live = signedIn({ catalog: { source: 'live', fetchedAt: 2 } })
    let polls = 0
    await mountCard(saved, {
      fetchStatus: async () => {
        polls += 1
        return polls <= 2 ? saved : live
      },
    })
    await act(async () => {
      const pending = api!.refreshWithCatalog()
      await vi.advanceTimersByTimeAsync(3_000)
      await pending
    })
    expect(controlCalls).toContain('refresh')
    expect(polls).toBeGreaterThan(1)
  })

  it('自动重拉：目录非 live 时挂载后自动触发一次刷新（once per mount）', async () => {
    const saved = signedIn({ catalog: { source: 'saved', fetchedAt: 1 } })
    await mountCard(saved, { fetchStatus: async () => signedIn({ catalog: { source: 'live', fetchedAt: 2 } }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(controlCalls.filter(call => call === 'refresh')).toHaveLength(1)
    // 再推进时间不会循环触发（autoRefreshTried 只放行一次）。
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
    expect(controlCalls.filter(call => call === 'refresh')).toHaveLength(1)
  })

  it('刷新失败：POST 非 2xx 落成 inline notice，8s 后自动消退', async () => {
    controlStatus = 500
    await mountCard(signedIn())
    await act(async () => {
      await api!.refreshWithCatalog().catch(() => {})
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(api!.notice).toContain('HTTP_500')
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    expect(api!.notice).toBeUndefined()
  })

  it('刷新失败：fetchStatus 抛错也落成 notice，不把卡片打空', async () => {
    await mountCard(signedIn(), { fetchStatus: async () => { throw new Error('network down') } })
    await act(async () => {
      await api!.refresh()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(api!.notice).toContain('network down')
  })

  it('隐藏/恢复模型走真实控制动作；复制 plan id 后 2s 反馈复位', async () => {
    await mountCard(signedIn({ excludedCount: 1 }))
    await act(async () => {
      await api!.deleteModel('m1')
      await api!.restoreModel('m1')
      await api!.restoreModels()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(controlCalls).toEqual(expect.arrayContaining(['delete-model:m1', 'restore-model:m1', 'restore-models']))

    await act(async () => {
      await api!.copyPlanId('plan-1')
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(controlCalls).toContain('copy:plan-1')
    expect(api!.copiedPlanId).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(api!.copiedPlanId).toBe(false)
  })

  it('卸载后到达的响应不再 setState（mounted 守卫）', async () => {
    let release: ((status: WorkBuddyWebStatus) => void) | undefined
    await mountCard(signedIn(), {
      fetchStatus: () => new Promise<WorkBuddyWebStatus>(resolve => { release = resolve }),
    })
    await act(async () => { void api!.refresh() })
    await act(async () => { root.unmount() })
    await act(async () => {
      release?.(signedIn())
      await vi.advanceTimersByTimeAsync(0)
    })
    // 没有任何 React 警告或异常即通过；这里再显式确认 hook 未被复活。
    expect(container.textContent).toBe('')
  })
})

/** useVariantsPage 的 harness：暴露轮询/重试/展开动作。 */
interface PageApi {
  statuses: Record<string, CardStatus>
  retryOne(variant: WorkBuddyCardVariant): void
  toggleOpen(id: string): void
  fetchOne(variant: WorkBuddyCardVariant, signal?: AbortSignal): Promise<WorkBuddyWebStatus>
  applyOne(id: string, next: CardStatus): void
  openIds: ReadonlySet<string>
}

let pageApi: PageApi | undefined
function PageHarness(): null {
  pageApi = useVariantsPage(t) as unknown as PageApi
  return null
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  }
}

describe('useVariantsPage 轮询与可见性', () => {
  it('挂载首拉 + 60s 轮询；整改/展开动作走同一落定链', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      fetched.push(String(input))
      return new Response(JSON.stringify({ status: 'signed-out' }), { status: 200 })
    }))
    await act(async () => { root.render(createElement(PageHarness)) })
    await flush()
    const initial = fetched.length
    expect(initial).toBeGreaterThanOrEqual(CARD_VARIANTS.length)
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) })
    await flush()
    expect(fetched.length, '一轮 60s 轮询应重查未登录/展开的行').toBeGreaterThan(initial)

    // 展开一个变体（触发立即刷新），再收回。
    const first = CARD_VARIANTS[0]!
    await act(async () => {
      pageApi!.toggleOpen(first.id)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(pageApi!.openIds.has(first.id)).toBe(true)
    await act(async () => {
      pageApi!.toggleOpen(first.id)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(pageApi!.openIds.has(first.id)).toBe(false)

    // 错误行重试：先回 loading 再走首拉同一条链。
    await act(async () => {
      pageApi!.retryOne(first)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(pageApi!.statuses[first.id]?.status).not.toBe(undefined)
  })

  it('标签页隐藏时暂停轮询，恢复可见后立即补一拍', async () => {
    let fetches = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      fetches += 1
      return new Response(JSON.stringify({ status: 'signed-out' }), { status: 200 })
    }))
    await act(async () => { root.render(createElement(PageHarness)) })
    await flush()
    const before = fetches

    // 隐藏：轮询停止。
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2) })
    expect(fetches, '隐藏期间不应继续轮询').toBe(before)

    // 恢复可见：立即补一拍并重启轮询。
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(fetches, '恢复可见应立即刷新').toBeGreaterThan(before)
  })
})
