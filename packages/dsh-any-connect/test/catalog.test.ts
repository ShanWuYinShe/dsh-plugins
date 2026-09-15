import { describe, expect, it } from 'vitest'
import { FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from '../src/catalog.js'

describe('WorkBuddyCatalog visibility', () => {
  it('serves the fallback roster while visible', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.isVisible()).toBe(true)
    expect(catalog.current().length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
  })

  it('serves an empty list while hidden but keeps the rows for later', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.setVisible(false)).toBe(true)
    expect(catalog.isVisible()).toBe(false)
    expect(catalog.current()).toEqual([])
    // Flipping back needs no re-fetch: the rows were kept.
    expect(catalog.setVisible(true)).toBe(true)
    expect(catalog.current().length).toBe(FALLBACK_WORKBUDDY_MODELS.length)
  })

  it('reports no change when the flag is already at the target value', () => {
    const catalog = new WorkBuddyCatalog()
    expect(catalog.setVisible(true)).toBe(false)
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
