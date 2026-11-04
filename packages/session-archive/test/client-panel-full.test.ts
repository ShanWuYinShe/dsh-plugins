// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import '../client/styles.js'
import { ArchivePanel } from '../client/ArchivePanel.js'
import { zh } from '../client/locales.js'
import type { TFunc } from '../client/locales.js'
import type { ArchiveDetailResult, ArchiveListResult } from '@chaoset/session-archive/types'

/**
 * 归档面板全链路 jsdom 行为回归（SA-19 / 覆盖率）：
 * 渲染真实 ArchivePanel 组件树（badge → header/toolbar/rows/详情/分页/确认条），
 * 注入 fake call 覆盖 useArchiveList / useArchiveViewState / useArchiveActions /
 * useArchivePanelChrome / useArchivePanelOpen 的打开、加载、筛选、排序、分页、
 * 勾选、详情、恢复、删除两段式、导出、关闭、提示自动消失与订阅刷新。
 */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const t: TFunc = (key) => zh[key]
const PAGE_SIZE = 50

type Item = ArchiveListResult['items'][number]
type Call = (method: string, ...args: any[]) => Promise<any>

function item(index: number, overrides: Partial<Item> = {}): Item {
  return {
    sessionId: 's' + index,
    title: '会话 ' + index,
    cwd: '/proj/' + index,
    createdAt: index,
    updatedAt: 1000 + index,
    size: 1024 * (index + 1),
    live: false,
    ...overrides,
  }
}

function detailOf(sessionId: string): ArchiveDetailResult {
  return {
    sessionId,
    header: { cwd: '/proj/a', createdAt: 1, parentSession: null, agentPreset: null },
    title: '会话',
    messageCount: 2,
    totalMessageCount: 2,
    truncated: false,
    messages: [
      { role: 'user', text: '你好', time: 10 },
      { role: 'assistant', text: '回复', time: 20 },
    ],
    live: false,
  }
}

interface Harness {
  items: Item[]
  detailThrows?: string[]
  deleteResult?: any
  unarchiveResult?: any
  calls: Array<{ method: string; args: any[] }>
  call: Call
  container: HTMLElement
  unmount: () => void
}

let reduceMotion = true
let mounted: Array<() => void> = []

function makeHarness(options: {
  items?: Item[]
  detailThrows?: string[]
  deleteResult?: any
  unarchiveResult?: any
  wide?: unknown
  subscribeArchived?: (listener: () => void) => () => void
  archivedCountOf?: () => number
} = {}): Harness {
  const items = options.items ?? [item(1), item(2)]
  const calls: Harness['calls'] = []
  const call: Call = async (method, ...args) => {
    calls.push({ method, args })
    switch (method) {
      case 'list': return { items }
      case 'count': return { count: items.length }
      case 'detail': {
        const id = String(args[0])
        if (options.detailThrows?.includes(id) === true) {
          const error = new Error('detail failed for ' + id) as Error & { code: string }
          error.code = 'session-archive/not-archived'
          throw error
        }
        return detailOf(id)
      }
      case 'unarchive': return options.unarchiveResult ?? { restored: args[0], failed: [], removedFromArchive: args[0].length }
      case 'delete': return options.deleteResult ?? { deleted: args[0], failed: [], removedFromArchive: 0, needsRestart: [] }
      default: throw new Error('unexpected method ' + method)
    }
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const element = React.createElement(ArchivePanel as never, {
    wide: 'wide' in options ? options.wide : true,
    call,
    t,
    refreshSessions: async () => {},
    subscribeArchived: options.subscribeArchived,
    archivedCountOf: options.archivedCountOf,
  } as never)
  act(() => { root.render(element) })
  const unmount = () => { act(() => root.unmount()); container.remove() }
  mounted.push(unmount)
  return { items, calls, call, container, unmount, ...options }
}

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

function click(element: Element | null): void {
  if (element === null) throw new Error('click target missing')
  act(() => { (element as HTMLElement).click() })
}

async function clickAsync(element: Element | null): Promise<void> {
  if (element === null) throw new Error('click target missing')
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve() })
}

function byText(container: HTMLElement, selector: string, text: string, at = 0): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(selector)].filter((el) => el.textContent?.includes(text))[at]
}

function typeInto(input: Element | null, value: string): void {
  if (input === null) throw new Error('input missing')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function openPanel(h: Harness): Promise<void> {
  await clickAsync(h.container.querySelector('button.sa_badge'))
  await flush()
}

beforeEach(() => {
  reduceMotion = true;
  (window as any).matchMedia = ((query: string) => ({
    matches: reduceMotion && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as any
  (globalThis as any).ResizeObserver = class {
    constructor(callback: (entries: any[]) => void) { (globalThis as any).__roCallback = callback }
    observe(): void {}
    disconnect(): void {}
  };
  (URL as any).createObjectURL = vi.fn(() => 'blob:test')
  ;(URL as any).revokeObjectURL = vi.fn()
})

afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('ArchivePanel 打开/加载/关闭全链路', () => {
  it('徽标点击打开面板、加载列表并渲染行；Esc 关闭（reduce-motion 直接关）', async () => {
    const h = makeHarness()
    expect(h.container.querySelector('.sa_panel')).toBeNull()
    await openPanel(h)
    expect(h.calls.some((c) => c.method === 'list')).toBe(true)
    expect(h.container.querySelector('.sa_panel')).not.toBeNull()
    expect(h.container.querySelectorAll('.sa_row')).toHaveLength(2)
    // 面板打开时焦点移入面板。
    expect(document.activeElement).toBe(h.container.querySelector('.sa_panel'))

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(h.container.querySelector('.sa_panel')).toBeNull()
    // 关闭后焦点归还徽标。
    expect(document.activeElement).toBe(h.container.querySelector('button.sa_badge'))
  })

  it('关闭动画：非 reduce-motion 时先 closing，动画中再点徽标 = 取消关闭并重开', async () => {
    reduceMotion = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = makeHarness()
    await openPanel(h)
    reduceMotion = false
    await clickAsync(h.container.querySelector('button.sa_badge')) // 触发关闭动画
    expect(h.container.querySelector('.sa_panel--closing')).not.toBeNull()
    await clickAsync(h.container.querySelector('button.sa_badge')) // 动画中点击 = 重开
    expect(h.container.querySelector('.sa_panel--closing')).toBeNull()
    // 再次关闭并推进动画结束。
    await clickAsync(h.container.querySelector('button.sa_badge'))
    act(() => { vi.advanceTimersByTime(200) })
    expect(h.container.querySelector('.sa_panel')).toBeNull()
  })

  it('点击面板外关闭（pointerdown 在 root 之外）', async () => {
    const h = makeHarness()
    await openPanel(h)
    act(() => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(h.container.querySelector('.sa_panel')).toBeNull()
  })

  it('Tab 键在面板内环绕焦点（焦点陷阱）；无关闭动画时 Tab 不越界', async () => {
    const h = makeHarness()
    await openPanel(h)
    const panel = h.container.querySelector('.sa_panel')!
    const focusables = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    const last = focusables[focusables.length - 1]!
    last.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })) })
    expect(document.activeElement).toBe(focusables[0])
    // Shift+Tab 从第一个回到最后一个。
    focusables[0]!.focus()
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })) })
    expect(document.activeElement).toBe(last)
  })
})

describe('筛选/排序/分页/勾选', () => {
  it('筛选输入过滤行；无匹配时显示空态并可一键清空', async () => {
    const h = makeHarness({ items: [item(1), item(2), item(3)] })
    await openPanel(h)
    typeInto(h.container.querySelector('input.sa_filterInput'), '会话 2')
    await flush()
    expect(h.container.querySelectorAll('.sa_row')).toHaveLength(1)
    typeInto(h.container.querySelector('input.sa_filterInput'), '不存在的词')
    await flush()
    expect(h.container.querySelectorAll('.sa_row')).toHaveLength(0)
    expect(h.container.textContent).toContain(zh.noMatch)
    click(byText(h.container, 'button.sa_action', zh.clearFilter) ?? null)
    await flush()
    expect(h.container.querySelectorAll('.sa_row')).toHaveLength(3)
  })

  it('排序按钮循环 time → size → title', async () => {
    const h = makeHarness({ items: [item(1), item(2)] })
    await openPanel(h)
    const sortButton = (): HTMLElement => h.container.querySelector('div.sa_toolbar button.sa_action')!
    expect(sortButton().textContent).toContain(zh.sortBy_time)
    click(sortButton())
    expect(sortButton().textContent).toContain(zh.sortBy_size)
    click(sortButton())
    expect(sortButton().textContent).toContain(zh.sortBy_title)
    click(sortButton())
    expect(sortButton().textContent).toContain(zh.sortBy_time)
  })

  it('超过一页时显示「加载更多」，点击追加一页', async () => {
    const items = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => item(i))
    const h = makeHarness({ items })
    await openPanel(h)
    expect(h.container.querySelectorAll('.sa_row')).toHaveLength(PAGE_SIZE)
    const more = byText(h.container, 'button.sa_action', zh.showMore.replace('{n}', '5'))!
    click(more)
    expect(h.container.querySelectorAll('.sa_row')).toHaveLength(PAGE_SIZE + 5)
  })

  it('全选与半选：勾选后计数与按钮态变化', async () => {
    const h = makeHarness({ items: [item(1), item(2)] })
    await openPanel(h)
    const selectAll = h.container.querySelector('label.sa_toolLabel input.sa_check') as HTMLInputElement
    click(selectAll)
    await flush()
    expect(h.container.textContent).toContain(zh.selected.replace('{n}', '2'))
    click(selectAll) // 取消全选
    await flush()
    expect(h.container.textContent).toContain(zh.selected.replace('{n}', '0'))
  })

  it('单行恢复按钮：点击即恢复该行（stopPropagation 不触发展开/批量）', async () => {
    const h = makeHarness({ items: [item(1)] })
    await openPanel(h)
    await clickAsync(h.container.querySelector('.sa_row button[title="' + zh.restoreOneTitle + '"]'))
    await flush()
    expect(h.calls.filter((c) => c.method === 'unarchive')).toHaveLength(1)
    expect(h.container.textContent).toContain(zh.restoreDone.replace('{n}', '1'))
    // stopPropagation：未触发行展开详情。
    expect(h.calls.some((c) => c.method === 'detail')).toBe(false)
  })

  it('live 会话行：不显示恢复/导出按钮，勾选框禁用', async () => {
    const h = makeHarness({ items: [item(1, { live: true })] })
    await openPanel(h)
    expect(h.container.querySelector('.sa_row button[title="' + zh.restoreOneTitle + '"]')).toBeNull()
    expect(h.container.querySelector('.sa_row button[title="' + zh.exportMd + '"]')).toBeNull()
    const checkbox = h.container.querySelector('.sa_row input.sa_check') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(h.container.textContent).toContain(zh.live)
  })

  it('选中行触发恢复：批量恢复成功后展示成功提示', async () => {
    const h = makeHarness({ items: [item(1), item(2)] })
    await openPanel(h)
    click(h.container.querySelectorAll('.sa_row input.sa_check')[0]!)
    await flush()
    click(byText(h.container, 'button.sa_action', zh.restore) ?? null)
    await flush()
    expect(h.calls.filter((c) => c.method === 'unarchive')).toHaveLength(1)
    expect(h.container.textContent).toContain(zh.restoreDone.replace('{n}', '1'))
  })
})

describe('详情/导出/删除拼装', () => {
  it('展开行加载详情并渲染消息；再次点击收起', async () => {
    const h = makeHarness({ items: [item(1)] })
    await openPanel(h)
    await clickAsync(h.container.querySelector('.sa_rowTitle'))
    await flush()
    expect(h.calls.some((c) => c.method === 'detail' && c.args[0] === 's1')).toBe(true)
    expect(h.container.querySelectorAll('.sa_msg')).toHaveLength(2)
    await clickAsync(h.container.querySelector('.sa_rowTitle'))
    expect(h.container.querySelectorAll('.sa_msg')).toHaveLength(0)
  })

  it('详情失败按 code 本地化展示，且再次点击会重试', async () => {
    const h = makeHarness({ items: [item(1)], detailThrows: ['s1'] })
    await openPanel(h)
    await clickAsync(h.container.querySelector('.sa_rowTitle'))
    await flush()
    expect(h.container.textContent).toContain(zh.errorNotArchived)
    const before = h.calls.filter((c) => c.method === 'detail').length
    await clickAsync(h.container.querySelector('.sa_rowTitle'))
    await flush()
    await clickAsync(h.container.querySelector('.sa_rowTitle'))
    await flush()
    expect(h.calls.filter((c) => c.method === 'detail').length).toBeGreaterThan(before)
  })

  it('删除两段式：第一次点击进入确认态，第二次真正删除并展示 needsRestart 提示', async () => {
    const h = makeHarness({
      items: [item(1)],
      deleteResult: { deleted: ['s1'], failed: [], removedFromArchive: 0, needsRestart: ['s1'] },
    })
    await openPanel(h)
    click(h.container.querySelectorAll('.sa_row input.sa_check')[0]!)
    await flush()
    const deleteButton = (): HTMLElement | undefined => byText(h.container, 'button.sa_action', zh.delete)
    click(deleteButton() ?? null)
    expect(h.container.textContent).toContain(zh.deleteConfirm)
    const confirmButton = byText(h.container, 'button.sa_action', zh.deleteConfirm)!
    await clickAsync(confirmButton)
    await flush()
    expect(h.calls.some((c) => c.method === 'delete')).toBe(true)
    expect(h.container.textContent).toContain(zh.restartNeeded.replace('{n}', '1'))
  })

  it('≥5 项删除出现勾选确认条；未勾选时确认按钮禁用，勾选后可点', async () => {
    const h = makeHarness({ items: Array.from({ length: 5 }, (_, i) => item(i)) })
    await openPanel(h)
    const selectAll = h.container.querySelector('label.sa_toolLabel input.sa_check') as HTMLInputElement
    click(selectAll)
    await flush()
    click(byText(h.container, 'button.sa_action', zh.delete) ?? null)
    expect(h.container.querySelector('.sa_ack')).not.toBeNull()
    expect(h.container.textContent).toContain(zh.deleteConfirmBody.replace('{n}', '5'))
    const confirmButtons = [...h.container.querySelectorAll('button')].filter((b) => b.textContent === zh.confirmAll.replace('{n}', '5'))
    expect((confirmButtons[0] as HTMLButtonElement).disabled).toBe(true)
    const ack = h.container.querySelector('.sa_ack input.sa_check') as HTMLInputElement
    click(ack)
    await flush()
    expect(([...h.container.querySelectorAll('button')].filter((b) => b.textContent === zh.confirmAll.replace('{n}', '5'))[0] as HTMLButtonElement).disabled).toBe(false)
    // 取消确认条回到未 armed 态。
    click(byText(h.container, 'button.sa_action', zh.cancel) ?? null)
    await flush()
    expect(h.container.querySelector('.sa_ack')).toBeNull()
  })

  it('批量删除部分失败按 reason 本地化展示（含未知 reason 原样透出）', async () => {
    const h = makeHarness({
      items: [item(1), item(2)],
      deleteResult: {
        deleted: ['s1'],
        failed: [
          { sessionId: 's2', reason: 'busy' },
          { sessionId: 's3', reason: 'weird-reason' },
        ],
        removedFromArchive: 0,
        needsRestart: [],
      },
    })
    await openPanel(h)
    const selectAll = h.container.querySelector('label.sa_toolLabel input.sa_check') as HTMLInputElement
    click(selectAll)
    await flush()
    click(byText(h.container, 'button.sa_action', zh.delete) ?? null)
    // 2 项已选：armed 后按钮文案是「确认删除全部 2 个？」。
    await clickAsync(byText(h.container, 'button.sa_action', zh.confirmAll.replace('{n}', '2')) ?? null)
    await flush()
    expect(h.container.textContent).toContain(zh.runningHint)
    expect(h.container.textContent).toContain('weird-reason')
  })

  it('导出勾选会话：成功下载 Markdown；加载失败走 exportPartial 提示', async () => {
    const h = makeHarness({ items: [item(1)] })
    await openPanel(h)
    click(h.container.querySelectorAll('.sa_row input.sa_check')[0]!)
    await flush()
    await clickAsync(byText(h.container, 'button.sa_action', zh.exportMd) ?? null)
    await flush()
    expect((URL as any).createObjectURL).toHaveBeenCalled()
    expect(h.container.textContent).toContain(zh.exportDone.replace('{n}', '1'))

    const failing = makeHarness({ items: [item(1)], detailThrows: ['s1'] })
    await openPanel(failing)
    click(failing.container.querySelectorAll('.sa_row input.sa_check')[0]!)
    await flush()
    await clickAsync(byText(failing.container, 'button.sa_action', zh.exportMd) ?? null)
    await flush()
    expect(failing.container.textContent).toContain(zh.exportPartial.replace('{n}', '1'))
  })

  it('单行导出：成功下载；失败展示详细错误', async () => {
    const rowExport = (container: HTMLElement): Element | null => container.querySelector('.sa_row button.sa_action[title="' + zh.exportMd + '"]')
    const h = makeHarness({ items: [item(1)] })
    await openPanel(h)
    await clickAsync(rowExport(h.container))
    await flush()
    expect(h.container.textContent).toContain(zh.exportDone.replace('{n}', '1'))

    const failing = makeHarness({ items: [item(1)], detailThrows: ['s1'] })
    await openPanel(failing)
    await clickAsync(rowExport(failing.container))
    await flush()
    expect(failing.container.textContent).toContain(zh.detailLoadFailed)
    expect(failing.container.textContent).toContain(zh.errorNotArchived)
  })
})

describe('列表数据源：轮询/可见性/宿主 store 订阅', () => {
  it('关闭态轮询 count；页面隐藏时暂停、恢复可见时立即刷新', async () => {
    const h = makeHarness()
    await flush()
    const countCalls = (): number => h.calls.filter((c) => c.method === 'count').length
    expect(countCalls()).toBeGreaterThan(0)
    const before = countCalls()
    let visibility: DocumentVisibilityState = 'hidden'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    visibility = 'visible'
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(countCalls()).toBeGreaterThan(before)
  })

  it('宿主归档集合变化时按 store 计数触发刷新', async () => {
    let listener: (() => void) | null = null
    let count = 1
    const h = makeHarness({
      subscribeArchived: (fn) => { listener = fn; return () => { listener = null } },
      archivedCountOf: () => count,
    })
    await flush()
    const before = h.calls.filter((c) => c.method === 'count').length
    count = 2
    await act(async () => { listener?.(); await Promise.resolve() })
    expect(h.calls.filter((c) => c.method === 'count').length).toBeGreaterThan(before)
    // 计数未变化时不重复刷新。
    const afterFirst = h.calls.filter((c) => c.method === 'count').length
    await act(async () => { listener?.(); await Promise.resolve() })
    expect(h.calls.filter((c) => c.method === 'count').length).toBe(afterFirst)
  })

  it('打开态每 30s 静默刷新列表', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = makeHarness()
    await openPanel(h)
    const before = h.calls.filter((c) => c.method === 'list').length
    act(() => { vi.advanceTimersByTime(30_000) })
    await flush()
    expect(h.calls.filter((c) => c.method === 'list').length).toBeGreaterThan(before)
  })

  it('提示 4 秒后自动消失', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const h = makeHarness({ items: [item(1)] })
    await openPanel(h)
    click(h.container.querySelectorAll('.sa_row input.sa_check')[0]!)
    await flush()
    await clickAsync(byText(h.container, 'button.sa_action', zh.restore) ?? null)
    await flush()
    expect(h.container.textContent).toContain(zh.restoreDone.replace('{n}', '1'))
    act(() => { vi.advanceTimersByTime(4100) })
    await flush()
    expect(h.container.textContent).not.toContain(zh.restoreDone.replace('{n}', '1'))
  })
})

describe('徽标收起态', () => {
  it('host 下发 wide=false 时只渲染图标（无文字标签）', () => {
    const h = makeHarness({ wide: false })
    const badge = h.container.querySelector('button.sa_badge')!
    expect(badge.classList.contains('sa_badge--collapsed')).toBe(true)
    expect(badge.textContent).not.toContain(zh.badge)
  })

  it('未下发 wide 时按容器宽度兜底（ResizeObserver < 80px 视为收起）', async () => {
    const h = makeHarness({ wide: undefined })
    const badge = h.container.querySelector('button.sa_badge')!
    expect(badge.classList.contains('sa_badge--collapsed')).toBe(false)
    act(() => { (globalThis as any).__roCallback([{ contentRect: { width: 40 } }]) })
    expect(h.container.querySelector('button.sa_badge')!.classList.contains('sa_badge--collapsed')).toBe(true)
    act(() => { (globalThis as any).__roCallback([{ contentRect: { width: 200 } }]) })
    expect(h.container.querySelector('button.sa_badge')!.classList.contains('sa_badge--collapsed')).toBe(false)
  })
})
