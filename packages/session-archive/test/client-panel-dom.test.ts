// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ArchiveRow } from '../client/ArchiveRow.js'
import { ArchiveToolbar } from '../client/ArchiveToolbar.js'
import { ArchiveDeleteAck } from '../client/ArchiveDeleteAck.js'
import { ArchiveBadge } from '../client/ArchiveBadge.js'
import type { TFunc } from '../client/locales.js'
import type { ArchiveDetailResult, ArchiveListResult } from '@chaoset/session-archive/types'

/**
 * 面板组件 jsdom 行为回归（SA-19 / RULE-087）：此前包内 client 测试全是
 * 纯函数/描述符断言，删除确认态、详情展开、错误态、批量闸门等用户可见行为
 * 零覆盖。这里渲染真实组件（createElement 树），断言 DOM 与回调。
 */

// React 19 的 act 需要显式声明测试环境。
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 回显键名的 t 桩：保留 {n} 占位符供组件 replace。 */
const t: TFunc = (key) => 'T:' + key + ' {n}'

type Item = ArchiveListResult['items'][number]

function item(overrides: Partial<Item> = {}): Item {
  return { sessionId: 's1', title: '标题A', cwd: '/proj/a', createdAt: 1, updatedAt: 2, size: 1024, live: false, ...overrides }
}

function detail(overrides: Partial<ArchiveDetailResult> = {}): ArchiveDetailResult {
  return {
    sessionId: 's1',
    header: { cwd: '/proj/a', createdAt: 1, parentSession: null, agentPreset: null },
    title: '标题A',
    messageCount: 2,
    totalMessageCount: 2,
    truncated: false,
    messages: [
      { role: 'user', text: '你好', time: 1000 },
      { role: 'assistant', text: '回复', time: 2000 },
    ],
    live: false,
    ...overrides,
  }
}

let mounted: Array<() => void> = []

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(element) })
  mounted.push(() => { act(() => root.unmount()); container.remove() })
  return container
}

function click(element: Element | null): void {
  if (element === null) throw new Error('click target missing')
  act(() => { (element as HTMLElement).click() })
}

afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose()
  document.body.innerHTML = ''
})

describe('ArchiveRow（详情展开与错误态）', () => {
  it('展开态渲染消息列表（角色本地化 + 文本）；点击标题触发 toggleDetail', () => {
    const toggleDetail = vi.fn()
    const container = render(React.createElement(ArchiveRow as never, {
      item: item(),
      t,
      selected: new Set<string>(),
      expanded: 's1',
      details: new Map([['s1', detail()]]),
      detailLoading: new Set<string>(),
      busy: false,
      toggleOne: vi.fn(),
      toggleDetail,
      restoreOne: vi.fn(),
      exportOne: vi.fn(),
    } as never))
    expect(container.querySelectorAll('.sa_msg')).toHaveLength(2)
    expect(container.textContent).toContain('你好')
    expect(container.textContent).toContain('T:user')
    expect(container.textContent).toContain('T:assistant')
    click(container.querySelector('.sa_rowTitle'))
    expect(toggleDetail).toHaveBeenCalledTimes(1)
    expect(toggleDetail.mock.calls[0]![0].sessionId).toBe('s1')
  })

  it('详情失败态渲染本地化错误文案，不渲染消息', () => {
    const container = render(React.createElement(ArchiveRow as never, {
      item: item(),
      t,
      selected: new Set<string>(),
      expanded: 's1',
      details: new Map([['s1', { error: '该会话不是归档会话' }]]),
      detailLoading: new Set<string>(),
      busy: false,
      toggleOne: vi.fn(),
      toggleDetail: vi.fn(),
      restoreOne: vi.fn(),
    } as never))
    expect(container.querySelector('.sa_error')?.textContent).toBe('该会话不是归档会话')
    expect(container.querySelectorAll('.sa_msg')).toHaveLength(0)
  })

  it('live 行禁用勾选框；选中行带 selected class', () => {
    const container = render(React.createElement(ArchiveRow as never, {
      item: item({ live: true }),
      t,
      selected: new Set(['s1']),
      expanded: null,
      details: new Map(),
      detailLoading: new Set<string>(),
      busy: false,
      toggleOne: vi.fn(),
      toggleDetail: vi.fn(),
      restoreOne: vi.fn(),
    } as never))
    expect((container.querySelector('input.sa_check') as HTMLInputElement).disabled).toBe(true)
    expect(container.querySelector('li.sa_row')?.classList.contains('sa_row--selected')).toBe(true)
  })
})

describe('ArchiveToolbar（批量闸门与两段式确认）', () => {
  it('≥5 项且 armed 但未勾选确认时删除按钮禁用；勾选后可点', () => {
    const props = {
      t,
      selected: new Set(['a', 'b', 'c', 'd', 'e']),
      detailLoading: new Set<string>(),
      busy: false,
      confirmingDelete: true,
      deleteAcked: false,
      filter: '',
      setFilter: vi.fn(),
      sortKey: 'time' as const,
      setSortKey: vi.fn(),
      selectable: [item()],
      allSelected: false,
      toggleAll: vi.fn(),
      exportSelected: vi.fn(),
      restoreSelected: vi.fn(),
      deleteSelected: vi.fn(),
      hasSelection: true,
    }
    const container = render(React.createElement(ArchiveToolbar as never, props as never))
    const buttons = [...container.querySelectorAll('button.sa_action')]
    const deleteButton = buttons[2] as HTMLButtonElement
    expect(deleteButton.disabled).toBe(true)
    expect(deleteButton.textContent).toContain('T:confirmAll')

    const acked = render(React.createElement(ArchiveToolbar as never, { ...props, deleteAcked: true } as never))
    const ackedDelete = [...acked.querySelectorAll('button.sa_action')][2] as HTMLButtonElement
    expect(ackedDelete.disabled).toBe(false)
  })

  it('未 armed 时删除按钮走两段式文案（deleteConfirm）', () => {
    const container = render(React.createElement(ArchiveToolbar as never, {
      t,
      selected: new Set(['a']),
      detailLoading: new Set<string>(),
      busy: false,
      confirmingDelete: false,
      deleteAcked: false,
      filter: '',
      setFilter: vi.fn(),
      sortKey: 'size' as const,
      setSortKey: vi.fn(),
      selectable: [item()],
      allSelected: false,
      toggleAll: vi.fn(),
      exportSelected: vi.fn(),
      restoreSelected: vi.fn(),
      deleteSelected: vi.fn(),
      hasSelection: true,
    } as never))
    const buttons = [...container.querySelectorAll('button.sa_action')]
    expect(buttons[2]!.textContent).toContain('T:delete')
    // 排序按钮文案由动态键 sortBy_size 返回。
    expect(buttons[0]!.textContent).toContain('T:sortBy_size')
  })
})

describe('ArchiveDeleteAck（大批量勾选确认条）', () => {
  it('阈值下不出现；阈值上勾选/取消分别回调 setDeleteAcked / disarmDelete', () => {
    const hidden = render(React.createElement(ArchiveDeleteAck as never, {
      t, selected: new Set(['a', 'b']), confirmingDelete: true, deleteAcked: false,
      setDeleteAcked: vi.fn(), disarmDelete: vi.fn(),
    } as never))
    expect(hidden.querySelector('.sa_ack')).toBeNull()

    const setDeleteAcked = vi.fn()
    const disarmDelete = vi.fn()
    const container = render(React.createElement(ArchiveDeleteAck, {
      t,
      selected: new Set(['a', 'b', 'c', 'd', 'e']),
      confirmingDelete: true,
      deleteAcked: false,
      setDeleteAcked,
      disarmDelete,
    }))
    expect(container.querySelector('.sa_ack')?.textContent).toContain('T:deleteConfirmBody')
    const checkbox = container.querySelector('input.sa_check') as HTMLInputElement
    act(() => { checkbox.click() })
    expect(setDeleteAcked).toHaveBeenCalledWith(true)
    const cancel = [...container.querySelectorAll('button.sa_action')].find((button) => button.textContent?.includes('T:cancel'))
    click(cancel ?? null)
    expect(disarmDelete).toHaveBeenCalledTimes(1)
  })
})

describe('ArchiveBadge（开关手势）', () => {
  it('未开/已开/关闭动画中分别触发 openPanel/closePanel/reopen', () => {
    const openPanel = vi.fn()
    const closePanel = vi.fn()
    const reopen = vi.fn()
    const base = { t, badgeRef: React.createRef<HTMLButtonElement>(), iconOnly: false, items: [item()], badgeCount: 1, badgeTitle: 'T:badge (1)' }

    const closed = render(React.createElement(ArchiveBadge as never, { ...base, open: false, closing: false, openPanel, closePanel, reopen } as never))
    click(closed.querySelector('button.sa_badge'))
    expect(openPanel).toHaveBeenCalledTimes(1)

    const opened = render(React.createElement(ArchiveBadge as never, { ...base, open: true, closing: false, openPanel, closePanel, reopen } as never))
    click(opened.querySelector('button.sa_badge'))
    expect(closePanel).toHaveBeenCalledTimes(1)

    const closing = render(React.createElement(ArchiveBadge as never, { ...base, open: true, closing: true, openPanel, closePanel, reopen } as never))
    click(closing.querySelector('button.sa_badge'))
    expect(reopen).toHaveBeenCalledTimes(1)
  })
})
