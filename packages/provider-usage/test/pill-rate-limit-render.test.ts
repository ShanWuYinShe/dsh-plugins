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
async function renderPill(
  answer: SnapshotAnswer,
  currentModel: string | undefined = 'glm-5.3',
): Promise<string> {
  const state: ModelDirectoryState = {
    ...readyState,
    current: currentModel === undefined ? null : { provider: 'zcode', model: currentModel } as never,
  }
  const props = {
    t,
    sessionId: 'session-1',
    resolveSeat: () => ({ directory, load: () => {} }),
    useModelDirectory: () => state,
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
      rateLimits: [{ blockedAt: Date.now(), lastSeenAt: Date.now(), resetAt: Date.now() + 3_600_000, status: 429, hits: 2 }],
    })
    // 通道被拒时，即使还剩 80% 额度，头行也必须先说限流。
    expect(text).toContain('until:')
    expect(text).not.toContain('remaining')
  })

  it('限流头行带模型名：用户一眼看出是哪个模型被限，而不是整个 provider', async () => {
    const text = await renderPill({
      provider: 'workbuddy',
      windows: [{ id: 'w', label: '积分', remain: 80, unit: '', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [{ blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 1, model: 'glm-5.3' }],
    })
    expect(text).toContain('glm-5.3')
  })

  it('限流但上游没给恢复时刻：如实说「未提供」', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [{ blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 1 }],
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

  it('限流属于别的模型：换到当前模型后不再显示限流（只提示当前模型）', async () => {
    // 场景：A 模型（glm-5.3）被限，用户切到 B 模型（glm-4.6）。
    // pill 只显示当前选中模型的限流，B 可用就不该显示「限流中」。
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [{ blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 2, model: 'glm-5.3' }],
    }, 'glm-4.6')
    // 头行回到额度数字，不是限流文案。
    expect(text).toContain('remaining')
    expect(text).not.toContain('rateLimitedUnknown')
    expect(text).not.toContain('glm-5.3')
  })

  it('限流属于当前模型：仍然显示（不误伤真实限流）', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [{ blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 2, model: 'glm-4.6' }],
    }, 'glm-4.6')
    expect(text).toContain('rateLimitedUnknown')
    expect(text).toContain('glm-4.6')
  })

  it('限流没有模型维度：按 provider 级事实显示（不隐藏真实限流）', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [{ blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 1 }],
    }, 'glm-4.6')
    expect(text).toContain('rateLimitedUnknown')
  })

  it('多个模型同时被限：只显示当前选中模型那条（不罗列其它模型）', async () => {
    // wire 带全部观测，但界面严格只显示当前选中模型 glm-4.6 的限流。
    const text = await renderPill({
      provider: 'workbuddy',
      windows: [{ id: 'w', label: '积分', remain: 80, unit: '', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [
        { blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 2, model: 'glm-5.3' },
        { blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 1, model: 'glm-4.6' },
      ],
    }, 'glm-4.6')
    expect(text).toContain('rateLimitedUnknown')
    expect(text).toContain('glm-4.6')
    // 其它模型既不进头行也不进面板。
    expect(text).not.toContain('glm-5.3')
  })

  it('切回先前被限的模型：它的限流信息还在（wire 带全部观测的真正用途）', async () => {
    const answer = {
      provider: 'workbuddy',
      windows: [{ id: 'w', label: '积分', remain: 80, unit: '', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [
        { blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 2, model: 'glm-5.3' },
        { blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 1, model: 'glm-4.6' },
      ],
    }
    // 先看 glm-4.6：显示 glm-4.6 的限流。
    expect(await renderPill(answer, 'glm-4.6')).toContain('glm-4.6')
    // 切回 glm-5.3：glm-5.3 的限流仍在（wire 只带一条时这里就丢了）。
    const back = await renderPill(answer, 'glm-5.3')
    expect(back).toContain('glm-5.3')
    expect(back).toContain('rateLimitedUnknown')
    expect(back).not.toContain('glm-4.6')
  })

  it('当前模型没被限：不显示任何限流信息（哪怕其它模型被限）', async () => {
    const text = await renderPill({
      provider: 'workbuddy',
      windows: [{ id: 'w', label: '积分', remain: 80, unit: '', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [
        { blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 2, model: 'glm-5.3' },
      ],
    }, 'glm-4.6')
    expect(text).toContain('remaining')
    expect(text).not.toContain('rateLimited')
    expect(text).not.toContain('glm-5.3')
  })

  it('展开面板：上游披露策略字段时补一行 policy/余量/窗口详情', async () => {
    const now = Date.now()
    await renderPill({
      provider: 'workbuddy',
      windows: [{ id: 'w', label: '积分', remain: 80, unit: '', limit: 100 }],
      fetchedAt: now,
      rateLimits: [{
        blockedAt: now, lastSeenAt: now, resetAt: now + 3_600_000, status: 429, hits: 2,
        model: 'glm-5.3', policy: 'rpm', metric: 'requests', limit: 60, remaining: 0, windowSeconds: 60,
      }],
    })
    const button = container.querySelector('button')
    expect(button).not.toBeNull()
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const opened = container.textContent ?? ''
    expect(opened).toContain('rpm')
    expect(opened).toContain('windowRemaining')
    expect(opened).toContain('rateLimitWindow')
  })

  it('观测不属于当前模型：不显示该限流（头行与面板一致）', async () => {
    const text = await renderPill({
      provider: 'zcode',
      windows: [{ id: 'w', label: '5 小时', remain: 80, unit: '%', limit: 100 }],
      fetchedAt: Date.now(),
      rateLimits: [{ blockedAt: Date.now(), lastSeenAt: Date.now(), status: 429, hits: 3, model: 'glm-5.3' }],
    }, 'glm-4.6')
    expect(text).not.toContain('hits:3')
    expect(text).not.toContain('glm-5.3')
    expect(text).not.toContain('rateLimited')
  })
})
