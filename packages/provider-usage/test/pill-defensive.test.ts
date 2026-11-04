// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ProviderUsagePill } from '../client/ProviderUsagePill.js'
import { fallbackTranslate } from '../client/locales.js'
import type { ProviderUsagePillProps } from '../client/pill-types.js'
import type { SnapshotAnswer } from '../client/fetch-snapshot.js'

/**
 * pill 的渲染防御回归（RULE-079）：
 *
 * - 宿主 inject 契约漂移、缺 `t` 时**不得抛错**——render 期抛错会让宿主
 *   `SlotErrorBoundary` → `reportEntryError({abdicate:true})` 把 entry 永久移出
 *   投影（pill 再也不显示）。改为 console.error 一次 + 包内英文兜底继续渲染。
 * - 数字/时间格式化跟随注入面拿到的 DSH 语言（`useLocale`），而不是浏览器
 *   语言；locale 面缺席（旧宿主）时退回浏览器默认，格式化仍可用。
 */

const readyState: ModelDirectoryState = {
  current: { provider: 'zcode', model: 'glm-5.3' } as never,
  pending: null,
  routable: true,
  groups: [],
  failures: [],
  status: 'ready',
  error: null,
}

const directory = {
  subscribe: () => () => {},
  getSnapshot: () => readyState,
}

const answer: SnapshotAnswer = {
  provider: 'zcode',
  windows: [{ id: 'w', label: 'Credits', remain: 1234.5, unit: 'credits' }],
  fetchedAt: Date.now(),
}

let root: Root | null = null
let container: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // 缺 t 的兜底路径会按设计打 console.error：除专门断言它的用例外静默掉，
  // 保持测试输出干净。
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root?.unmount() })
  container.remove()
  root = null
  vi.restoreAllMocks()
})

/** 渲染 pill；`localeId` 给了就模拟宿主绑定的 useLocale hook。 */
async function renderPill(localeId?: string): Promise<string> {
  const props: Record<string, unknown> = {
    sessionId: 'session-1',
    resolveSeat: () => ({ directory, load: () => {} }),
    useResource: () => ({ status: 'live', value: answer, failure: undefined }),
  }
  if (localeId !== undefined) {
    // 宿主 renderer 把 inject.hooks.locale 绑定成 selector hook：
    // 调用方传 selector，hook 返回选中值。
    props['useLocale'] = (selector: (snapshot: unknown) => unknown) => selector({ active: localeId, locales: [], revision: 1 })
  }
  await act(async () => {
    root!.render(createElement(ProviderUsagePill, props as unknown as ProviderUsagePillProps))
  })
  return container.textContent ?? ''
}

describe('fallbackTranslate', () => {
  it('替换 {name} 占位符（与宿主 t 的模板语法一致）', () => {
    expect(fallbackTranslate('noQuerier', { provider: 'acme' })).toBe('acme usage is not reported')
    expect(fallbackTranslate('resetsAt', { time: 'Nov 5, 2026' })).toBe('Resets Nov 5, 2026')
  })

  it('缺参时占位符原样保留，不渲染成 undefined', () => {
    expect(fallbackTranslate('rateLimitHits')).toBe('{count} refusals')
    expect(fallbackTranslate('noQuerier', {})).toBe('{provider} usage is not reported')
  })
})

describe('缺 t 时的渲染防御', () => {
  it('只 console.error 一次，不抛错，用英文兜底继续渲染', async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    try {
      // 若组件仍像旧实现那样在 render 期 throw，这里的 act/render 会直接红，
      // 等价于宿主侧「entry 被永久 abdicate」的失效路径。
      const text = await renderPill()
      expect(text).toContain('1,234.5 credits left')
      const expected = errors.filter(line => line.includes('provider-usage: pill missing translation seat'))
      expect(expected).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('格式化跟随 DSH 语言（useLocale）', () => {
  it('注入面给了 localeId 时数字按该语言分组（de-DE）', async () => {
    const text = await renderPill('de-DE')
    // de-DE：千分位「.」、小数「,」——用浏览器 locale 会得到 1,234.5。
    expect(text).toContain('1.234,5 credits left')
    expect(text).not.toContain('1,234.5')
  })

  it('locale 面缺席（旧宿主/契约漂移）时退回浏览器默认，不抛错', async () => {
    const text = await renderPill()
    expect(text).toContain('1,234.5 credits left')
  })
})
