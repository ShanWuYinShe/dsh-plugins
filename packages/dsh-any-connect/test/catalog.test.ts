import { describe, expect, it } from 'vitest'
import {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_ZCODE_MODELS,
  WorkBuddyCatalog,
} from '../src/catalog.js'
import * as WorkBuddy from '../src/index.js'

/**
 * 可见性开关的回归：无凭据的变体必须服务空列表（而不是让用户看到一份
 * 点选必错的名单），恢复可见时无需重拉——行还在。
 */
describe('WorkBuddyCatalog visibility', () => {
  it('serves an empty list while hidden but keeps the rows for later', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.setVisible(false)).toBe(true)
    expect(catalog.current()).toEqual([])
    // Flipping back needs no re-fetch: the rows were kept.
    expect(catalog.setVisible(true)).toBe(true)
    expect(catalog.current().length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
  })

  it('replacement rows are served once visible', () => {
    const catalog = new WorkBuddyCatalog()
    catalog.setVisible(false)
    catalog.set([{ id: 'live', name: 'Live', contextWindow: 1, maxTokens: 1, supportsImages: false }])
    expect(catalog.current()).toEqual([])
    catalog.setVisible(true)
    expect(catalog.current().map(m => m.id)).toEqual(['live'])
  })
})

describe('Provider model parameter & billing isolation', () => {
  it('preserves distinct parameters and billing for same-named models across providers', () => {
    const wbCatalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS, 'workbuddy')
    const aiCatalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_AI_MODELS, 'workbuddy')
    const zcodeCatalog = new WorkBuddyCatalog(FALLBACK_ZCODE_MODELS, 'zcode')

    // GLM-5.3 parameters differ significantly across all 3 providers
    const wbGlm53 = wbCatalog.current().find(m => m.id === 'glm-5.3')
    const aiGlm53 = aiCatalog.current().find(m => m.id === 'glm-5.3')
    const zcodeGlm53 = zcodeCatalog.current().find(m => m.id === 'glm-5.3')

    expect(wbGlm53).toBeDefined()
    expect(aiGlm53).toBeDefined()
    expect(zcodeGlm53).toBeDefined()

    // WorkBuddy CN: 64k output ceiling, x0.79 rate
    expect(wbGlm53?.maxTokens).toBe(64000)
    expect(wbGlm53?.billing?.credits).toBe('x0.79')
    expect(wbGlm53?.billing?.badges).toBeUndefined()

    // WorkBuddy AI: 48k output ceiling, x0.79 rate
    expect(aiGlm53?.maxTokens).toBe(48000)
    expect(aiGlm53?.billing?.credits).toBe('x0.79')

    // ZCode Coding Plan: 128k output ceiling, x1.00 rate, 150% quota badge
    expect(zcodeGlm53?.maxTokens).toBe(128000)
    expect(zcodeGlm53?.billing?.credits).toBe('x1.00')
    expect(zcodeGlm53?.billing?.badges).toContain('150% 额度')

    // GLM-5.3-Flash parameters differ between WorkBuddy CN and ZCode
    const wbFlash = wbCatalog.current().find(m => m.id === 'glm-5.3-flash')
    const zcodeFlash = zcodeCatalog.current().find(m => m.id === 'glm-5.3-flash')

    expect(wbFlash).toBeDefined()
    expect(zcodeFlash).toBeDefined()

    // WorkBuddy CN: 32k maxTokens, no night-free badge, never marked free
    expect(wbFlash?.maxTokens).toBe(32000)
    expect(wbFlash?.billing?.credits).toBe('x0.06')
    expect(wbFlash?.billing?.free).toBe(false)
    expect(wbFlash?.billing?.badges).toBeUndefined()

    // ZCode: 128k maxTokens, has night-free badge & 150% quota badge
    expect(zcodeFlash?.maxTokens).toBe(128000)
    expect(zcodeFlash?.billing?.badges).toContain('150% 额度')

    // Hy4 preview context window differs between CN (1M) and Global (200k)
    const wbHy4 = wbCatalog.current().find(m => m.id === 'hy4-preview')
    const aiHy4 = aiCatalog.current().find(m => m.id === 'hy4-preview')

    expect(wbHy4?.contextWindow).toBe(1000000)
    expect(wbHy4?.billing?.credits).toBe('x0.29')
    expect(aiHy4?.contextWindow).toBe(200000)
    expect(aiHy4?.billing?.credits).toBe('x0.29')
  })

  it('does not apply ZCode off-peak logic to WorkBuddy models with night-free badges', () => {
    // Beijing 02:00 (off-peak night window)
    const nightTime = Date.parse('2026-09-24T18:00:00Z') // 18:00 UTC = 02:00 Beijing time
    const dayTime = Date.parse('2026-09-24T06:00:00Z') // 06:00 UTC = 14:00 Beijing time

    const wbCatalog = new WorkBuddyCatalog(FALLBACK_WORKBUDDY_MODELS, 'workbuddy')
    const hy4Night = wbCatalog.current().find(m => m.id === 'hy4-preview')
    expect(hy4Night?.billing?.credits).toBe('x0.29')
    expect(hy4Night?.billing?.free).toBe(false)

    // ZCode model follows off-peak night window
    const zcodeCatalog = new WorkBuddyCatalog(FALLBACK_ZCODE_MODELS, 'zcode')
    const flashNight = zcodeCatalog.current().find(m => m.id === 'glm-5.3-flash')

    // During daytime, ZCode retains its own baseline credits x0.06 without hardcoded overwrites
    const zcodeDayModel = FALLBACK_ZCODE_MODELS.find(m => m.id === 'glm-5.3-flash')!
    const resolvedDay = WorkBuddy.modelWithCurrentPromotion(zcodeDayModel, dayTime, 'zcode')
    expect(resolvedDay.billing?.free).toBe(false)
    expect(resolvedDay.billing?.credits).toBe('x0.06')
    expect(resolvedDay.billing?.badges).toContain('夜间免费')
    expect(resolvedDay.billing?.badges).not.toContain('夜间免费 (生效中)')

    // During night, ZCode turns free x0.00
    const resolvedNight = WorkBuddy.modelWithCurrentPromotion(zcodeDayModel, nightTime, 'zcode')
    expect(resolvedNight.billing?.free).toBe(true)
    expect(resolvedNight.billing?.credits).toBe('x0.00')
    expect(resolvedNight.billing?.badges).toContain('夜间免费 (生效中)')

    // WorkBuddy Hy4 during night is NOT altered by ZCode offpeak
    const hy4Model = FALLBACK_WORKBUDDY_MODELS.find(m => m.id === 'hy4-preview')!
    const resolvedWbHy4 = WorkBuddy.modelWithCurrentPromotion(hy4Model, nightTime, 'workbuddy')
    expect(resolvedWbHy4.billing?.credits).toBe('x0.29')
    expect(resolvedWbHy4.billing?.free).toBe(false)
  })
})
