// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WindowRow } from '../client/WindowRow.js'
import type { ProviderUsageLocaleKey } from '../client/locales.ts'

/** WindowRow remain 缺席分支回归：有 limit 无 remain 时不渲染进度条。 */

const t = (key: ProviderUsageLocaleKey): string => key

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
})

describe('WindowRow', () => {
  it('有 limit 无 remain：只显示 unit，不渲染进度条', () => {
    act(() => {
      root!.render(createElement(WindowRow, {
        window: { id: 'w', label: 'Tokens', unit: 't', limit: 100 },
        t,
      }))
    })
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.textContent).toContain('t')
    expect(container.textContent).not.toContain('0 t')
  })

  it('有 remain 有 limit：渲染进度条与剩余数', () => {
    act(() => {
      root!.render(createElement(WindowRow, {
        window: { id: 'w', label: 'Tokens', unit: 't', limit: 100, remain: 30 },
        t,
      }))
    })
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(container.textContent).toContain('30 t')
  })
})
