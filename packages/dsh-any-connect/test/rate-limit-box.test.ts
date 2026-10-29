// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RateLimitBox } from '../client/RateLimitBox.js'
import type { WorkBuddyWebRateLimit } from '../src/status-paths.js'

/**
 * 卡片限流框回归。
 *
 * 这个框是用户「到底到什么时候能接着用」在卡片侧的答案，因此每条断言都在锁
 * 同一件事：**只说上游说过的事实**。有恢复时刻就说几点；没有就如实说「未提供」，
 * 并且给出被限时长——绝不按固定窗口编一个倒计时。
 */

const t = (key: string, params?: Record<string, unknown>): string => {
  if (key === 'rateLimitResetsAt') return `resets:${String(params!['time'])}`
  if (key === 'rateLimitUnknownReset') return `unknown:${String(params!['elapsed'])}`
  if (key === 'rateLimitMeta') return `meta:${String(params!['count'])}:${String(params!['model'])}`
  return key
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

function render(rateLimit: WorkBuddyWebRateLimit | undefined, nowMs?: number): string {
  act(() => {
    root!.render(createElement(RateLimitBox, { t: t as never, rateLimit, nowMs }))
  })
  return container.textContent ?? ''
}

describe('RateLimitBox', () => {
  it('没有限流时整块不渲染', () => {
    expect(render(undefined)).toBe('')
  })

  it('上游给了恢复时刻 → 说几点恢复', () => {
    const now = new Date('2026-10-29T10:00:00Z').getTime()
    const text = render({ blockedAt: now - 60_000, lastSeenAt: now, resetAt: now + 30 * 60_000, status: 429, hits: 2 }, now)
    expect(text).toContain('rateLimitTitle')
    expect(text).toContain('resets:')
    expect(text).not.toContain('unknown:')
  })

  it('上游没给恢复时刻 → 如实说「未提供」，并给出已等时长', () => {
    const now = new Date('2026-10-29T10:00:00Z').getTime()
    const text = render({ blockedAt: now - 90_000, lastSeenAt: now, status: 429, hits: 3 }, now)
    expect(text).toContain('unknown:2min')
    expect(text).not.toContain('resets:')
  })

  it('显示被拒次数与模型名', () => {
    const now = 1_000_000
    const text = render({ blockedAt: now, lastSeenAt: now, status: 429, hits: 5, model: 'glm-5.3' }, now)
    expect(text).toContain('meta:5:glm-5.3')
  })

  it('模型未知时说「全部模型」而不是留空', () => {
    const now = 1_000_000
    const text = render({ blockedAt: now, lastSeenAt: now, status: 429, hits: 1 }, now)
    expect(text).toContain('rateLimitAnyModel')
  })

  it('秒级已等时长按秒显示', () => {
    const now = 1_000_000
    const text = render({ blockedAt: now - 5_000, lastSeenAt: now, status: 429, hits: 1 }, now)
    expect(text).toContain('unknown:5s')
  })
})
