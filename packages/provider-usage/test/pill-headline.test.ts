import { describe, expect, it } from 'vitest'
import { headlineText } from '../client/pill-headline.ts'
import type { ProviderUsageLocaleKey } from '../client/locales.ts'

/** 文案桩：key 原样返回，params 拼后面——分支断言只看选了哪个 key。 */
function t(key: ProviderUsageLocaleKey, params?: Record<string, unknown>): string {
  return params === undefined ? `[${key}]` : `[${key}:${JSON.stringify(params)}]`
}

describe('headlineText', () => {
  it('无 answer 显示 loading', () => {
    expect(headlineText(undefined, 'acme', false, t)).toBe('[loading]')
  })

  it('未注册 querier 显示 noQuerier（带 provider 名）', () => {
    expect(headlineText({ provider: 'acme', queried: false }, 'acme', false, t)).toBe('[noQuerier:{"provider":"acme"}]')
  })

  it('有 error 且无 windows 显示 failed', () => {
    expect(headlineText(
      { provider: 'acme', windows: [], fetchedAt: 1, error: 'boom' }, 'acme', false, t,
    )).toBe('[failed]')
  })

  it('无 error 无 windows 显示 noWindows', () => {
    expect(headlineText({ provider: 'acme', windows: [], fetchedAt: 1 }, 'acme', false, t)).toBe('[noWindows]')
  })

  it('首 window 无 remain 显示 label + unit（多 window 带 +N 后缀）', () => {
    expect(headlineText(
      { provider: 'acme', windows: [{ id: 'w', label: 'CNY', unit: 'cny' }, { id: 'x', label: 'USD', unit: 'usd' }], fetchedAt: 1 },
      'acme', false, t,
    )).toBe('CNY: cny +1')
  })

  it('首 window 有 remain 显示格式化额度 + remaining（多 window 带 +N 后缀）', () => {
    expect(headlineText(
      { provider: 'acme', windows: [{ id: 'w', label: 'W', remain: 3, unit: 'credits' }], fetchedAt: 1 },
      'acme', false, t,
    )).toBe('3 credits [remaining]')
  })

  it('stale 时追加 staleData 后缀', () => {
    expect(headlineText(undefined, 'acme', true, t)).toBe('[loading] · [staleData]')
  })
})
