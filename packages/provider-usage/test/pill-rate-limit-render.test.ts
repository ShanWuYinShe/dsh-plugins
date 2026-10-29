// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderUsagePill } from '../client/ProviderUsagePill.js'
import type { ProviderUsageLocaleKey } from '../client/locales.js'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotAnswer } from '../client/fetch-snapshot.js'
import type { ProviderUsagePillProps } from '../client/pill-types.js'

/**
 * 端到端渲染回归：限流态与「额度用尽」态在 pill 上的真实呈现。
 *
 * 这两条是用户「到什么时候能接着用」的最终落点，前面所有单测（台账、文案、
 * 类型）都只是为它们服务。这里走真实组件 + 真实 hook，额度由 resources 的
 * live 流交付（useResource 桩），断言 DOM 里真的长出了对应文案。
 */

const t = (key: ProviderUsageLocaleKey, params?: Record<string, unknown>): string => {
  if (key === 'rateLimitedUntil') return `until:${String(params!['time'])}`
  if (key === 'rateLimitedUnknown') return 'rateLimitedUnknown'
  if (key === 'rateLimitHits') return `hits:${String(params!['count'])}`
  if (key === 'resetsAt') return `resets:${String(params!['time'])}`
  return key
}

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

/** 用一条 resource live 帧渲染 pill（额度数据唯一通道）。 */
async function renderPill(answer: SnapshotAnswer): Promise<string> {
  const props = {
    t,
    sessionId: 'session-1',
    resolveSeat: () => ({ directory, load: () => {} }),
    useResource: () => ({ status: 'live', value: answer, failure: undefined }),
  } as unknown as ProviderUsagePillProps
  await act(async () => {
    root!.render(createElement(ProviderUsagePill, props))
  })
  return container.textContent ?? ''
}

describe('pill 端到端：限流与额度用尽', () => {
  it('限流态：折叠文案说「限流中」并带上游给的恢复时刻', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimit: { blockedAt: Date.now(), lastSeenAt: Date.now(), resetAt: Date.now() + 3_600_000, status: 429, hits: 2 },
    })
    // 通道被拒时，即使还剩 80% 额度，头行也必须先说限流。
    expect(text).toContain('until:')
    expect(text).not.toContain('remaining')
  })

  it('限流但上游没给恢复时刻：如实说「未提供」', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimit: { blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 1 },
    })
    expect(text).toContain('rateLimitedUnknown')
  })

  it('额度用尽：显示 0 剩余，且 title 补上恢复时刻', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 0, unit: '%', limit: 100, resetsAt: '2026-10-29T12:00:00Z' }],
      fetchedAt: Date.now(),
    })
    expect(text).toContain('remaining') // 「0 % 剩余」——诚实展示
    // 恢复时刻在按钮的 title 上（折叠态放不下，但必须可达）。
    const button = container.querySelector('button')
    expect(button?.getAttribute('title')).toContain('resets:')
  })

  it('正常有余量：不显示恢复时刻（不打扰）', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 45, unit: '%', limit: 100, resetsAt: '2026-10-29T12:00:00Z' }],
      fetchedAt: Date.now(),
    })
    expect(text).toContain('remaining')
    const button = container.querySelector('button')
    expect(button?.getAttribute('title')).toBeNull()
  })
})
