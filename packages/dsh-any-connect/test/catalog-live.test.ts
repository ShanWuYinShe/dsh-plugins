import { describe, expect, it } from 'vitest'
import { isCatalogLive } from '../client/WorkBuddyConfigPage.tsx'
import type { WorkBuddyWebCatalog } from '../src/status-paths.js'

/**
 * 目录落定判据回归：refresh 轮询与 stale 自动重拉共用同一条“新鲜”定义
 * （live 且无错误）。saved/fallback/带错/缺失一律视为未落定。
 */
describe('isCatalogLive', () => {
  it('live 且无错误即落定', () => {
    expect(isCatalogLive({ source: 'live', fetchedAt: 1 } as WorkBuddyWebCatalog)).toBe(true)
  })
  it('saved/fallback 视为未落定', () => {
    expect(isCatalogLive({ source: 'saved' } as WorkBuddyWebCatalog)).toBe(false)
    expect(isCatalogLive({ source: 'fallback' } as WorkBuddyWebCatalog)).toBe(false)
  })
  it('live 但带错误视为未落定', () => {
    expect(isCatalogLive({ source: 'live', error: 'boom' } as WorkBuddyWebCatalog)).toBe(false)
  })
  it('缺失视为未落定', () => {
    expect(isCatalogLive(undefined)).toBe(false)
  })
})
