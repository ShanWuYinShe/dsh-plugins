import { describe, expect, it } from 'vitest'
import { FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/catalog.js'

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
