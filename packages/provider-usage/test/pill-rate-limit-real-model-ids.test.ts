import { describe, expect, it } from 'vitest'
import { rateLimitForCurrentModel } from '../client/pill-rate-limit-scope.js'
import type { UsageRateLimit } from '../src/types.js'

/**
 * 真实模型 id 回归：WorkBuddy 上游 live 目录里的两个 Hy4 行 id 是
 * `hy4free`（x0.00 / free）与 `hy4std`（x0.29）。
 *
 * 两者的 display name 相同，模型选择器里由「免费」徽章区分档位——用户分得清；
 * 但程序侧（限流归属判定）没有任何徽章可依据，只能比 id，因此这两个 id
 * 必须被当成**不同模型**。
 */

function obs(model?: string): UsageRateLimit {
  return { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 2, ...model === undefined ? {} : { model } }
}

describe('真实 WorkBuddy 模型 id：hy4free / hy4std 互不干扰', () => {
  it('限流来自 hy4free、当前选中 hy4std → 隐藏（这正是用户报的场景）', () => {
    expect(rateLimitForCurrentModel(obs('hy4free'), 'hy4std')).toBeUndefined()
  })

  it('限流来自 hy4std、当前选中 hy4free → 隐藏（反向同样成立）', () => {
    expect(rateLimitForCurrentModel(obs('hy4std'), 'hy4free')).toBeUndefined()
  })

  it('当前选中就是 hy4free → 显示', () => {
    expect(rateLimitForCurrentModel(obs('hy4free'), 'hy4free')?.model).toBe('hy4free')
  })

  it('当前选中就是 hy4std → 显示', () => {
    expect(rateLimitForCurrentModel(obs('hy4std'), 'hy4std')?.model).toBe('hy4std')
  })
})
