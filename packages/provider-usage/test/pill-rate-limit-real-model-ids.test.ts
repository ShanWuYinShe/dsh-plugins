import { describe, expect, it } from 'vitest'
import { selectRateLimitForCurrentModel } from '../client/pill-rate-limit-scope.js'
import type { UsageRateLimit, UsageSnapshot } from '../src/types.js'

/**
 * 真实模型 id 回归：WorkBuddy 上游 live 目录里的两个 Hy4 行 id 是
 * `hy4free`（x0.00 / free）与 `hy4std`（x0.29）。
 *
 * 两者的 display name 相同，模型选择器里由「免费」徽章区分档位——用户分得清；
 * 但程序侧（限流归属判定）没有任何徽章可依据，只能比 id，因此这两个 id
 * 必须被当成**不同模型**。
 */

function obs(model: string): UsageRateLimit {
  return { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 2, model }
}

function snapshotWith(limits: readonly UsageRateLimit[]): UsageSnapshot {
  return { provider: 'workbuddy-ai', windows: [], fetchedAt: 0, rateLimits: limits }
}

describe('真实 WorkBuddy 模型 id：hy4free / hy4std 互不干扰', () => {
  const snapshot = snapshotWith([obs('hy4free'), obs('hy4std')])

  it('选中 hy4std → 只显示 hy4std 的限流', () => {
    expect(selectRateLimitForCurrentModel(snapshot, 'hy4std')?.model).toBe('hy4std')
  })

  it('选中 hy4free → 只显示 hy4free 的限流', () => {
    expect(selectRateLimitForCurrentModel(snapshot, 'hy4free')?.model).toBe('hy4free')
  })

  it('选中别的模型 → 不显示（两个档位互不串扰）', () => {
    expect(selectRateLimitForCurrentModel(snapshot, 'claude-opus-4')).toBeUndefined()
  })
})
