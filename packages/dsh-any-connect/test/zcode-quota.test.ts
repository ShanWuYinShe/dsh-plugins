import { describe, expect, it } from 'vitest'
import { codingPlanQuotaWindows, codingPlanWindowLabel, parseCodingPlanQuota } from '../src/zcode-quota.js'

/** 2026-10-08 本机 coding-plan key 实测的真实响应。 */
const LIVE_SHAPE = {
  code: 200,
  msg: '操作成功',
  data: {
    level: 'pro',
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0, nextResetTime: 1_791_403_544_725 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 24, nextResetTime: 1_791_865_446_983 },
      { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 0, usage: 1000, currentValue: 0, remaining: 1000, nextResetTime: 1_793_026_354_999 },
    ],
  },
}

describe('Coding Plan 窗口额度（monitor/usage/quota/limit）', () => {
  it('解析实测响应并映射成 pill 窗口（5 小时 / 7 天 / 工具调用）', () => {
    const quota = parseCodingPlanQuota(LIVE_SHAPE)
    expect(quota?.level).toBe('pro')
    expect(quota?.limits).toHaveLength(3)
    expect(codingPlanQuotaWindows(quota!)).toEqual([
      { id: 'tokens_limit-3-5', label: '5 小时', remain: 100, limit: 100, unit: '%', resetsAt: new Date(1_791_403_544_725).toISOString() },
      { id: 'tokens_limit-6-1', label: '7 天', remain: 76, limit: 100, unit: '%', resetsAt: new Date(1_791_865_446_983).toISOString() },
      { id: 'time_limit-5-1', label: '工具调用', remain: 1000, limit: 1000, unit: '次', resetsAt: new Date(1_793_026_354_999).toISOString() },
    ])
  })

  it('percentage 是「已用」百分比，并按 0..100 夹紧', () => {
    const windows = codingPlanQuotaWindows({
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 150 },
        { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: -5 },
      ],
    })
    // 150% 已用 → 剩余 0（不是负数）；-5% → 剩余 100（不是 105）。
    expect(windows[0]).toMatchObject({ label: '5 小时', remain: 0, limit: 100, unit: '%' })
    expect(windows[1]).toMatchObject({ label: '7 天', remain: 100, limit: 100, unit: '%' })
  })

  it('形状不符一律 undefined（调用方据此回退订阅窗口）', () => {
    // 把别的端点响应误喂进来必须挡住：订阅列表的 data 是数组。
    expect(parseCodingPlanQuota({ code: 200, data: [{ productName: 'GLM Coding Pro' }] })).toBeUndefined()
    expect(parseCodingPlanQuota({ code: 200 })).toBeUndefined()
    expect(parseCodingPlanQuota(null)).toBeUndefined()
    expect(parseCodingPlanQuota(undefined)).toBeUndefined()
    expect(parseCodingPlanQuota({ data: { limits: [] } })).toBeUndefined()
    expect(parseCodingPlanQuota({ data: { limits: [null, 1, 'x'] } })).toBeUndefined()
  })

  it('未知 unit 走通用标签，缺可展示数字的行被跳过', () => {
    expect(codingPlanWindowLabel({ type: 'TOKENS_LIMIT', unit: 99, number: 2 })).toBe('额度')
    expect(codingPlanWindowLabel({ type: 'TIME_LIMIT' })).toBe('工具调用')
    const windows = codingPlanQuotaWindows({
      limits: [
        { type: 'TOKENS_LIMIT' },        // 无 percentage → 跳过
        { type: 'TIME_LIMIT' },          // 无 remaining/usage → 跳过
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 5 },
      ],
    })
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ label: '5 小时', remain: 95 })
  })

  it('同 type/unit/number 重复时 id 仍然唯一（React key 不能撞）', () => {
    const windows = codingPlanQuotaWindows({
      limits: [
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1 },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 2 },
      ],
    })
    expect(windows).toHaveLength(2)
    expect(new Set(windows.map(w => w.id)).size).toBe(2)
  })
})
