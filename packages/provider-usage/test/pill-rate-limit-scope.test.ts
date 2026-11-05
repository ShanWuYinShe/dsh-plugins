import { describe, expect, it } from 'vitest'
import { selectRateLimitForCurrentModel } from '../client/pill-rate-limit-scope.js'
import type { UsageRateLimit, UsageSnapshot } from '../src/types.js'

/**
 * 限流归属判定回归：wire 带该 provider 的**全部**逐模型观测，pill 只挑当前
 * 选中模型那一条——换了同 provider 的另一个模型后，先前模型被限的事实不该
 * 挂在新模型上（会把「A 被限」误读成「整条通道不可用」）。
 */

function limit(model?: string): UsageRateLimit {
  return { blockedAt: 0, lastSeenAt: 0, status: 429, hits: 1, ...model === undefined ? {} : { model } }
}

function snapshotWith(rateLimits: unknown): UsageSnapshot {
  return { provider: 'workbuddy', windows: [], fetchedAt: 0, rateLimits: rateLimits as UsageSnapshot['rateLimits'] }
}

describe('selectRateLimitForCurrentModel：只显示当前选中模型的限流', () => {
  it('当前模型被限（多模型数组里精确命中）→ 显示那一条', () => {
    const snapshot = snapshotWith([limit('glm-5.3'), limit('glm-4.6')])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-4.6')?.model).toBe('glm-4.6')
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.model).toBe('glm-5.3')
  })

  it('其它模型被限、当前模型没被限 → undefined（不误报）', () => {
    expect(selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3')]), 'glm-4.6')).toBeUndefined()
  })

  it('精确命中优先于数组顺序：provider 级观测排在前面也不盖掉', () => {
    const snapshot = snapshotWith([limit(), limit('glm-5.3')])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')?.model).toBe('glm-5.3')
  })

  it('观测不带 model（provider 级）→ 无法判定归属，按真实限流展示', () => {
    const shown = selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3'), limit()]), 'glm-4.6')
    expect(shown?.model).toBeUndefined()
    expect(shown?.status).toBe(429)
  })

  it('当前模型未知（目录未解析/无会话）→ 不做推断，取最靠前一条', () => {
    const snapshot = snapshotWith([limit('glm-5.3'), limit('glm-4.6')])
    expect(selectRateLimitForCurrentModel(snapshot, undefined)?.model).toBe('glm-5.3')
    expect(selectRateLimitForCurrentModel(snapshot, '')?.model).toBe('glm-5.3')
  })

  it('模型名区分大小写与前后缀：不做模糊匹配', () => {
    const snapshot = snapshotWith([limit('GLM-5.3')])
    expect(selectRateLimitForCurrentModel(snapshot, 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3')]), 'glm-5.3-extra')).toBeUndefined()
  })

  it('wire 缺失/形状非法 → undefined，不在渲染期抛错', () => {
    expect(selectRateLimitForCurrentModel(undefined, 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith(undefined), 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith('nope'), 'glm-5.3')).toBeUndefined()
    expect(selectRateLimitForCurrentModel(snapshotWith([limit('glm-5.3')]), 'glm-5.3')?.model).toBe('glm-5.3')
  })
})
