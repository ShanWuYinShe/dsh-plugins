/**
 * Built-in querier parsing.
 *
 * These specs run against recorded response shapes rather than the live
 * endpoints: a billing call is the user's money, and a test suite that spent
 * credit every CI run would be worse than the bug it guards against.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_USAGE_QUERIERS, deepseekUsage, moonshotUsage, openrouterUsage } from '../src/providers.js'

/** Answer one URL with a JSON body. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = routes[url]
    if (route === undefined) throw new Error(`unexpected fetch: ${url}`)
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

afterEach(() => { vi.unstubAllGlobals() })

describe('BUILTIN_USAGE_QUERIERS', () => {
  it('registers the documented providers with display names', () => {
    expect([...BUILTIN_USAGE_QUERIERS.keys()]).toEqual(['deepseek', 'openrouter', 'moonshot'])
    expect(BUILTIN_USAGE_QUERIERS.get('deepseek')?.displayName).toBe('DeepSeek')
  })

  it('exposes a querier for every entry', () => {
    for (const entry of BUILTIN_USAGE_QUERIERS.values()) expect(typeof entry.querier).toBe('function')
  })
})

describe('deepseekUsage', () => {
  it('reports one window per currency', async () => {
    stubFetch({
      'https://api.deepseek.com/user/balance': {
        body: {
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '110.00', granted_balance: '0.00', topped_up_balance: '110.00' },
            { currency: 'USD', total_balance: '12.50' },
          ],
        },
      },
    })
    const snapshot = await deepseekUsage({ provider: 'deepseek', apiKey: 'k' })
    expect(snapshot.windows).toEqual([
      { id: 'balance-CNY', label: 'CNY', remain: 110, unit: 'cny' },
      { id: 'balance-USD', label: 'USD', remain: 12.5, unit: 'usd' },
    ])
    expect(snapshot.error).toBeUndefined()
  })

  it('honours a configured baseURL', async () => {
    stubFetch({
      'https://gw.internal/api/user/balance': { body: { balance_infos: [{ currency: 'CNY', total_balance: '1' }] } },
    })
    const snapshot = await deepseekUsage({ provider: 'deepseek', baseURL: 'https://gw.internal/api/', apiKey: 'k' })
    expect(snapshot.windows[0]?.remain).toBe(1)
  })

  it('reports nothing to show when no credential is configured', async () => {
    const snapshot = await deepseekUsage({ provider: 'deepseek' })
    expect(snapshot.windows).toEqual([])
    // Absent credential is not a failure the user should see as an error.
    expect(snapshot.error).toBeUndefined()
  })

  it('surfaces a non-2xx as an error rather than a wrong balance', async () => {
    stubFetch({ 'https://api.deepseek.com/user/balance': { status: 401, body: { error: 'bad key' } } })
    await expect(deepseekUsage({ provider: 'deepseek', apiKey: 'k' })).rejects.toThrow('401')
  })

  it('refuses a non-JSON body instead of guessing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 200 })))
    await expect(deepseekUsage({ provider: 'deepseek', apiKey: 'k' })).rejects.toThrow('non-JSON')
  })
})

describe('openrouterUsage', () => {
  it('prefers the key-scoped limit and falls back to account credits', async () => {
    stubFetch({
      'https://openrouter.ai/api/v1/key': { body: { data: { limit: 20, limit_remaining: 7.5, usage: 12.5 } } },
      'https://openrouter.ai/api/v1/credits': { body: { data: { total_credits: 30, total_usage: 12.5 } } },
    })
    const snapshot = await openrouterUsage({ provider: 'openrouter', apiKey: 'k' })
    expect(snapshot.windows).toEqual([
      { id: 'key', label: 'API key', remain: 7.5, unit: 'credits', limit: 20 },
      { id: 'account', label: 'Account credits', remain: 17.5, unit: 'credits', limit: 30 },
    ])
  })

  it('reports account credits when the key carries no limit', async () => {
    stubFetch({
      'https://openrouter.ai/api/v1/key': { body: { data: {} } },
      'https://openrouter.ai/api/v1/credits': { body: { data: { total_credits: 10, total_usage: 4 } } },
    })
    const snapshot = await openrouterUsage({ provider: 'openrouter', apiKey: 'k' })
    expect(snapshot.windows).toEqual([{ id: 'account', label: 'Account credits', remain: 6, unit: 'credits', limit: 10 }])
  })

  it('never reports a negative remaining balance', async () => {
    stubFetch({
      'https://openrouter.ai/api/v1/key': { status: 404, body: {} },
      'https://openrouter.ai/api/v1/credits': { body: { data: { total_credits: 5, total_usage: 9 } } },
    })
    const snapshot = await openrouterUsage({ provider: 'openrouter', apiKey: 'k' })
    expect(snapshot.windows[0]?.remain).toBe(0)
  })
})

describe('moonshotUsage', () => {
  it('splits available, cash, and voucher balances', async () => {
    stubFetch({
      'https://api.moonshot.cn/v1/users/me/balance': {
        body: { data: { available_balance: 42.5, cash_balance: 40, voucher_balance: 2.5 } },
      },
    })
    const snapshot = await moonshotUsage({ provider: 'moonshot', apiKey: 'k' })
    expect(snapshot.windows).toEqual([
      { id: 'available', label: 'Available balance', remain: 42.5, unit: 'cny' },
      { id: 'cash', label: 'Cash balance', remain: 40, unit: 'cny' },
      { id: 'voucher', label: 'Voucher', remain: 2.5, unit: 'cny' },
    ])
  })

  it('omits a zero voucher and a cash row that duplicates the total', async () => {
    stubFetch({
      'https://api.moonshot.cn/v1/users/me/balance': {
        body: { data: { available_balance: 8, cash_balance: 8, voucher_balance: 0 } },
      },
    })
    const snapshot = await moonshotUsage({ provider: 'moonshot', apiKey: 'k' })
    // available == cash here, so a second identical figure would be noise.
    expect(snapshot.windows.map(w => w.id)).toEqual(['available'])
  })

  it('reports an error when the endpoint yields no usable balance', async () => {
    stubFetch({ 'https://api.moonshot.cn/v1/users/me/balance': { body: { data: {} } } })
    const snapshot = await moonshotUsage({ provider: 'moonshot', apiKey: 'k' })
    expect(snapshot.windows).toEqual([])
    expect(snapshot.error).toContain('no usable balance')
  })
})
