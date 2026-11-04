// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelRow } from '../client/ModelRow.js'
import type { WorkBuddyWebModelRow } from '../src/status-paths.js'

/**
 * 模型行动作列回归：可见行只有「删除」，隐藏行只有「恢复」。
 *
 * 用户报告的痛点是「只能一键恢复全部」。修复的落点就是这一列——隐藏区每一行
 * 必须有自己的恢复按钮，且点击时回传的是**这一行**的 id（不是"全部"）。
 */

const t = (key: string): string => key

const row: WorkBuddyWebModelRow = {
  id: 'glm-5.3',
  name: 'GLM-5.3',
  contextWindow: 200_000,
  contextWindows: [200_000],
  free: true,
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
  act(() => { root?.unmount() })
  container.remove()
  root = null
})

function render(props: Record<string, unknown>): void {
  act(() => {
    root!.render(createElement('table', null, createElement('tbody', null,
      createElement(ModelRow, { row, t: t as never, efforts: undefined, even: false, ...props } as never),
    )))
  })
}

describe('ModelRow 动作列', () => {
  it('可见行：只有「删除」，没有「恢复」', () => {
    const deleted: string[] = []
    render({ onDelete: (id: string) => deleted.push(id) })
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('deleteModel')
    act(() => { buttons[0]!.click() })
    expect(deleted).toEqual(['glm-5.3'])
  })

  it('隐藏行：只有「恢复」，点击回传该行 id', () => {
    const restored: string[] = []
    render({ onRestore: (id: string) => restored.push(id) })
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.textContent).toBe('restoreModel')
    expect(buttons[0]!.getAttribute('title')).toBe('restoreModelHint')
    act(() => { buttons[0]!.click() })
    // 关键：回传的是这一行的 id，恢复动作因此只影响这一个模型。
    expect(restored).toEqual(['glm-5.3'])
  })

  it('隐藏行仍展示完整信息（名称/倍率/窗口/档位）', () => {
    render({ onRestore: () => {} })
    expect(container.textContent).toContain('GLM-5.3')
    // 免费模型显示 Free 徽标；上下文窗口照常格式化展示。
    expect(container.textContent).toContain('freeModel')
  })
})
