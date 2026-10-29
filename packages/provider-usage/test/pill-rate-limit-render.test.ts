// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProviderUsagePill } from '../client/ProviderUsagePill.js'
import type { ProviderUsageLocaleKey } from '../client/locales.js'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'

/**
 * 端到端渲染回归：限流态与「额度用尽」态在 pill 上的真实呈现。
 *
 * 这两条是用户「到什么时候能接着用」的最终落点，前面所有单测（台账、文案、
 * 类型）都只是为它们服务。这里走真实组件 + 真实 hook，断言 DOM 里真的长出了
 * 对应文案，而不是只验纯函数。
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

function directoryOf(snapshot: ModelDirectoryState) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
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
  act(() => { root?.unmount() })
  container.remove()
  root = null
  vi.unstubAllGlobals()
})

import { vi } from 'vitest'

function stubRoute(answer: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ snapshots: [answer] }),
  }) as unknown as Response))
}

async function renderPill(): Promise<string> {
  // 只交付 pill 真正读的注入面：SessionStandardProps 里的 useConversation /
  // useInput / inputActions 由宿主 renderer 提供，本组件并不消费；按组件真实
  // 依赖面构造 props，断言才是「这块代码能工作」而非「类型能拼过」。
  const props = {
    t,
    directory: directoryOf(readyState),
    load: () => {},
  } as unknown as Parameters<typeof ProviderUsagePill>[0]
  await act(async () => {
    root!.render(createElement(ProviderUsagePill, props))
  })
  // 等首轮 fetch 落定。
  await act(async () => { await Promise.resolve() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return container.textContent ?? ''
}

describe('pill 端到端：限流与额度用尽', () => {
  it('限流态：折叠文案说「限流中」并带上游给的恢复时刻', async () => {
    stubRoute({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimit: { blockedAt: Date.now(), lastSeenAt: Date.now(), resetAt: Date.now() + 3_600_000, status: 429, hits: 2 },
    })
    const text = await renderPill()
    // 通道被拒时，即使还剩 80% 额度，头行也必须先说限流。
    expect(text).toContain('until:')
    expect(text).not.toContain('remaining')
  })

  it('限流但上游没给恢复时刻：如实说「未提供」', async () => {
    stubRoute({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimit: { blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 1 },
    })
    const text = await renderPill()
    expect(text).toContain('rateLimitedUnknown')
  })

  it('额度用尽：显示 0 剩余，且 title 补上恢复时刻', async () => {
    stubRoute({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 0, unit: '%', limit: 100, resetsAt: '2026-10-29T12:00:00Z' }],
      fetchedAt: Date.now(),
    })
    const text = await renderPill()
    expect(text).toContain('remaining') // 「0 % 剩余」——诚实展示
    // 恢复时刻在按钮的 title 上（折叠态放不下，但必须可达）。
    const button = container.querySelector('button')
    expect(button?.getAttribute('title')).toContain('resets:')
  })

  it('正常有余量：不显示恢复时刻（不打扰）', async () => {
    stubRoute({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 45, unit: '%', limit: 100, resetsAt: '2026-10-29T12:00:00Z' }],
      fetchedAt: Date.now(),
    })
    const text = await renderPill()
    expect(text).toContain('remaining')
    const button = container.querySelector('button')
    expect(button?.getAttribute('title')).toBeNull()
  })
})
