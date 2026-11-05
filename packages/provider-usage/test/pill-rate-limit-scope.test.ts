import { describe, expect, it } from 'vitest'
import { rateLimitForCurrentModel } from '../client/pill-rate-limit-scope.js'
import type { UsageRateLimit } from '../src/types.js'

/**
 * 限流归属判定回归：pill 是 provider 级表面，而上游限流是**按模型**的。
 *
 * 用户场景：同一 provider 下 A 模型被限，换成 B 模型后 pill 仍显示限流——
 * 那会把「A 被限」误读成「整条通道不可用」，而 B 其实完全可用。
 */

function limit(model?: string): UsageRateLimit {
  return {
    blockedAt: 0,
    lastSeenAt: 0,
    status: 429,
    hits: 1,
    ...model === undefined ? {} : { model },
  }
}

describe('rateLimitForCurrentModel：限流只属于当前选中模型', () => {
  it('观测的模型与当前模型一致 → 展示', () => {
    expect(rateLimitForCurrentModel(limit('glm-5.3'), 'glm-5.3')?.model).toBe('glm-5.3')
  })

  it('观测的模型与当前模型不同 → 不展示（换模型后不再误报）', () => {
    expect(rateLimitForCurrentModel(limit('glm-5.3'), 'glm-4.6')).toBeUndefined()
  })

  it('观测没有模型维度 → 无法判定归属，按 provider 级事实展示', () => {
    expect(rateLimitForCurrentModel(limit(), 'glm-4.6')?.status).toBe(429)
  })

  it('当前模型未知（目录未解析/无会话）→ 不做推断，保持展示', () => {
    expect(rateLimitForCurrentModel(limit('glm-5.3'), undefined)?.model).toBe('glm-5.3')
    expect(rateLimitForCurrentModel(limit('glm-5.3'), '')?.model).toBe('glm-5.3')
  })

  it('没有限流观测 → 始终 undefined', () => {
    expect(rateLimitForCurrentModel(undefined, 'glm-5.3')).toBeUndefined()
    expect(rateLimitForCurrentModel(undefined, undefined)).toBeUndefined()
  })

  it('模型名区分大小写与前后缀：不做模糊匹配', () => {
    expect(rateLimitForCurrentModel(limit('GLM-5.3'), 'glm-5.3')).toBeUndefined()
    expect(rateLimitForCurrentModel(limit('glm-5.3'), 'glm-5.3-extra')).toBeUndefined()
  })
})
