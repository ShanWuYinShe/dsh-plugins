/**
 * ZCode 上游响应归一化的纯函数测试。
 *
 * 2026-10-08 补：这两段逻辑原先埋在 395 行的 upstream-zcode.ts 方法体里，只有整链路测试
 * 覆盖（要真发 HTTP）。抽成纯函数后可以逐条喂样本——「白名单是总闸」「本地收录沿用整行」
 * 「计划名用上游产品名」这些用户可见口径，现在都有直接断言。
 */

import { describe, expect, it } from 'vitest'
import { CODING_PLAN_FALLBACK_CREDITS, codingPlanCreditsFrom, mergeZCodeCatalogue } from '../src/upstream-zcode-normalize.js'
import type { WorkBuddyUpstreamModel } from '../src/upstream.js'

function local(id: string, extra: Partial<WorkBuddyUpstreamModel> = {}): WorkBuddyUpstreamModel {
  return { id, name: id, contextWindow: 128000, maxTokens: 8192, supportsImages: false, ...extra }
}

describe('mergeZCodeCatalogue', () => {
  it('白名单是总闸：上游列了但白名单没有的 id 不展示', () => {
    const merged = mergeZCodeCatalogue([], ['glm-5', 'glm-4'], new Set(['glm-5']))
    expect(merged.map((m) => m.id)).toEqual(['glm-5'])
  })

  it('本地收录过的沿用整行（窗口与费率不丢）', () => {
    const known = local('glm-5', { contextWindow: 999, maxTokens: 111 })
    const merged = mergeZCodeCatalogue([known], ['glm-5'], new Set(['glm-5']))
    expect(merged[0]).toBe(known)
  })

  it('白名单内但本地没收录的走保守默认', () => {
    const merged = mergeZCodeCatalogue([], ['GLM-New'], new Set(['glm-new']))
    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe('glm-new')
    expect(merged[0]?.name).toBe('GLM-New')
    expect(merged[0]?.contextWindow).toBe(200000)
  })

  it('上游没列但白名单仍有的本地模型保留（下架的才消失）', () => {
    const kept = local('glm-5')
    const dropped = local('glm-old')
    const merged = mergeZCodeCatalogue([kept, dropped], ['glm-5'], new Set(['glm-5']))
    expect(merged.map((m) => m.id)).toEqual(['glm-5'])
  })

  it('按小写 id 去重：上游与本地同一模型的两种拼写只出现一次', () => {
    const merged = mergeZCodeCatalogue([local('glm-5')], ['GLM-5'], new Set(['glm-5']))
    expect(merged).toHaveLength(1)
  })

  it('上游名单为空时只留白名单内的本地模型', () => {
    const merged = mergeZCodeCatalogue([local('a'), local('b')], [], new Set(['b']))
    expect(merged.map((m) => m.id)).toEqual(['b'])
  })
})

describe('codingPlanCreditsFrom', () => {
  it('有效订阅：标注有效、保留上游产品名作为计划名', () => {
    const credits = codingPlanCreditsFrom({ data: [{ productName: 'ZCode Trust Build', status: 'VALID' }] })
    expect(credits.total).toBe(1)
    expect(credits.accounts[0]?.packageName).toBe('ZCode Trust Build (有效)')
    expect(credits.accounts[0]?.planName).toBe('ZCode Trust Build')
    expect(credits.accounts[0]?.remain).toBe(1)
  })

  it('无效订阅：如实标注状态、remain 为 0', () => {
    const credits = codingPlanCreditsFrom({ data: [{ productName: 'ZCode Pro', status: 'EXPIRED' }] })
    expect(credits.accounts[0]?.packageName).toBe('ZCode Pro (EXPIRED)')
    expect(credits.accounts[0]?.remain).toBe(0)
    expect(credits.total).toBe(0)
  })

  it('缺少产品名时退回 Coding Plan', () => {
    const credits = codingPlanCreditsFrom({ data: [{ status: 'ACTIVE' }] })
    expect(credits.accounts[0]?.planName).toBe('Coding Plan')
  })

  it('有效期只在能解析时带上', () => {
    const iso = '2030-01-02T03:04:05.000Z'
    const withExpiry = codingPlanCreditsFrom({ data: [{ productName: 'P', status: 'VALID', expireTime: iso }] })
    expect(withExpiry.accounts[0]?.expiredAt).toBe(iso)
    const bad = codingPlanCreditsFrom({ data: [{ productName: 'P', status: 'VALID', expireTime: 'not-a-date' }] })
    expect(bad.accounts[0]?.expiredAt).toBeUndefined()
  })

  it('没有数据时回退兜底账户', () => {
    expect(codingPlanCreditsFrom({})).toEqual(CODING_PLAN_FALLBACK_CREDITS)
    expect(codingPlanCreditsFrom({ data: [] })).toEqual(CODING_PLAN_FALLBACK_CREDITS)
  })
})
