/**
 * Built-in querier parsing.
 *
 * These specs run against recorded response shapes rather than the live
 * endpoints: a billing call is the user's money, and a test suite that spent
 * credit every CI run would be worse than the bug it guards against.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_USAGE_QUERIERS,
  bigmodelUsage,
  deepseekUsage,
  minimaxUsage,
  moonshotUsage,
  openaiUsage,
  opencodeUsage,
  openrouterUsage,
  siliconflowUsage,
} from '../src/providers.js'

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
    expect([...BUILTIN_USAGE_QUERIERS.keys()]).toEqual([
      'deepseek',
      'openrouter',
      'moonshot',
      'siliconflow',
      'bigmodel',
      'minimax',
      'openai',
      'opencode',
      'opencode-go',
    ])
    expect(BUILTIN_USAGE_QUERIERS.get('deepseek')?.displayName).toBe('DeepSeek')
    expect(BUILTIN_USAGE_QUERIERS.get('siliconflow')?.displayName).toBe('SiliconFlow')
    expect(BUILTIN_USAGE_QUERIERS.get('bigmodel')?.displayName).toBe('BigModel')
    expect(BUILTIN_USAGE_QUERIERS.get('minimax')?.displayName).toBe('MiniMax')
    expect(BUILTIN_USAGE_QUERIERS.get('openai')?.displayName).toBe('OpenAI / OneAPI')
    expect(BUILTIN_USAGE_QUERIERS.get('opencode')?.displayName).toBe('OpenCode')
    expect(BUILTIN_USAGE_QUERIERS.get('opencode-go')?.displayName).toBe('OpenCode Go')
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

describe('siliconflowUsage', () => {
  it('reports total balance, available balance, and charge balance', async () => {
    stubFetch({
      'https://api.siliconflow.cn/v1/user/info': {
        body: {
          code: 20000,
          data: {
            totalBalance: '100.50',
            balance: '80.00',
            chargeBalance: '20.50',
          },
        },
      },
    })
    const snapshot = await siliconflowUsage({ provider: 'siliconflow', apiKey: 'sk-test' })
    expect(snapshot.windows).toEqual([
      { id: 'total', label: 'Total balance', remain: 100.5, unit: 'cny' },
      { id: 'balance', label: 'Available balance', remain: 80, unit: 'cny' },
      { id: 'charge', label: 'Recharge balance', remain: 20.5, unit: 'cny' },
    ])
    expect(snapshot.error).toBeUndefined()
  })

  it('omits balance rows when they duplicate totalBalance', async () => {
    stubFetch({
      'https://api.siliconflow.cn/v1/user/info': {
        body: {
          code: 20000,
          data: {
            totalBalance: '50.00',
            balance: '50.00',
            chargeBalance: '0.00',
          },
        },
      },
    })
    const snapshot = await siliconflowUsage({ provider: 'siliconflow', apiKey: 'sk-test' })
    expect(snapshot.windows).toEqual([
      { id: 'total', label: 'Total balance', remain: 50, unit: 'cny' },
    ])
  })

  it('reports empty windows when no apiKey configured', async () => {
    const snapshot = await siliconflowUsage({ provider: 'siliconflow' })
    expect(snapshot.windows).toEqual([])
  })
})

describe('bigmodelUsage', () => {
  it('parses coding plan quota limits with reset time', async () => {
    stubFetch({
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit': {
        body: {
          code: 200,
          data: {
            limits: [
              { type: 'TOKENS_LIMIT', unit: 3, percentage: 25, nextResetTime: 1740000000000 },
              { type: 'TIME_LIMIT', unit: 6, percentage: 10, nextResetTime: 1740500000000 },
            ],
          },
        },
      },
    })
    const snapshot = await bigmodelUsage({ provider: 'bigmodel', apiKey: 'sk-glm' })
    expect(snapshot.plan).toBe('Coding Plan')
    expect(snapshot.windows).toEqual([
      {
        id: 'tokens_limit',
        label: 'Token limit',
        remain: 75,
        limit: 100,
        unit: '%',
        resetsAt: new Date(1740000000000).toISOString(),
      },
      {
        id: 'time_limit',
        label: 'Time limit',
        remain: 90,
        limit: 100,
        unit: '%',
        resetsAt: new Date(1740500000000).toISOString(),
      },
    ])
  })

  it('falls back to subscription list when quota limit endpoint is not available', async () => {
    stubFetch({
      'https://open.bigmodel.cn/api/monitor/usage/quota/limit': { status: 404, body: {} },
      'https://bigmodel.cn/api/biz/subscription/list': {
        body: {
          code: 200,
          data: {
            list: [
              { productName: 'GLM Coding Pro', status: 'VALID', expireTime: '2026-10-01 00:00:00' },
            ],
          },
        },
      },
    })
    const snapshot = await bigmodelUsage({ provider: 'bigmodel', apiKey: 'sk-glm' })
    expect(snapshot.plan).toBe('GLM Coding Pro')
    expect(snapshot.windows).toEqual([
      {
        id: 'sub-glm-coding-pro',
        label: 'GLM Coding Pro',
        unit: 'VALID',
        resetsAt: '2026-10-01 00:00:00',
      },
    ])
  })
})

describe('minimaxUsage', () => {
  it('parses interval count and weekly count', async () => {
    stubFetch({
      'https://api.minimaxi.com/v1/token_plan/remains': {
        body: {
          current_interval_total_count: 100000,
          current_interval_usage_count: 20000,
          current_weekly_total_count: 1000000,
          current_weekly_usage_count: 150000,
        },
      },
    })
    const snapshot = await minimaxUsage({ provider: 'minimax', apiKey: 'sk-cp-test' })
    expect(snapshot.windows).toEqual([
      { id: 'interval', label: 'Rolling window (5h)', remain: 80000, limit: 100000, unit: 'tokens' },
      { id: 'weekly', label: 'Weekly window', remain: 850000, limit: 1000000, unit: 'tokens' },
    ])
  })

  it('parses remaining percent if total counts are absent', async () => {
    stubFetch({
      'https://api.minimaxi.com/v1/token_plan/remains': {
        body: {
          current_interval_remaining_percent: 65,
          current_weekly_remaining_percent: 92,
        },
      },
    })
    const snapshot = await minimaxUsage({ provider: 'minimax', apiKey: 'sk-cp-test' })
    expect(snapshot.windows).toEqual([
      { id: 'interval', label: 'Rolling window (5h)', remain: 65, limit: 100, unit: '%' },
      { id: 'weekly', label: 'Weekly window', remain: 92, limit: 100, unit: '%' },
    ])
  })
})

describe('openaiUsage', () => {
  it('calculates remaining balance by subtracting total_usage from hard_limit_usd', async () => {
    const now = new Date()
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    stubFetch({
      'https://api.openai.com/dashboard/billing/subscription': {
        body: {
          hard_limit_usd: 100,
          access_until: 1760000000,
          plan: { title: 'Pay-as-you-go' },
        },
      },
      [`https://api.openai.com/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`]: {
        body: {
          total_usage: 2500, // $25.00
        },
      },
    })
    const snapshot = await openaiUsage({ provider: 'openai', apiKey: 'sk-test' })
    expect(snapshot.plan).toBe('Pay-as-you-go')
    expect(snapshot.windows).toEqual([
      {
        id: 'balance',
        label: 'Balance',
        remain: 75,
        limit: 100,
        unit: 'usd',
        resetsAt: new Date(1760000000 * 1000).toISOString(),
      },
    ])
  })

  it('uses total_available directly when present', async () => {
    stubFetch({
      'https://api.openai.com/dashboard/billing/subscription': {
        body: {
          total_available: 42.5,
          hard_limit_usd: 100,
        },
      },
    })
    const snapshot = await openaiUsage({ provider: 'openai', apiKey: 'sk-test' })
    expect(snapshot.windows).toEqual([
      {
        id: 'balance',
        label: 'Balance',
        remain: 42.5,
        limit: 100,
        unit: 'usd',
      },
    ])
  })
})

describe('opencodeUsage', () => {
  it('parses rolling, weekly, and monthly quota windows', async () => {
    stubFetch({
      'https://opencode.ai/zen/go/v1/usage': {
        body: {
          usage: {
            rolling: { status: 'ok', percent: 8, resetsAt: '2026-09-24T11:00:46.539Z' },
            weekly: { status: 'ok', percent: 20, resetsAt: '2026-09-28T00:00:00.000Z' },
            monthly: { status: 'ok', percent: 38, resetsAt: '2026-10-12T14:16:37.000Z' },
          },
        },
      },
    })
    const snapshot = await opencodeUsage({ provider: 'opencode-go', apiKey: 'sk-test' })
    expect(snapshot.plan).toBe('OpenCode Go')
    expect(snapshot.windows).toEqual([
      {
        id: 'rolling',
        label: 'Rolling window (5h)',
        remain: 92,
        limit: 100,
        unit: '%',
        resetsAt: '2026-09-24T11:00:46.539Z',
      },
      {
        id: 'weekly',
        label: 'Weekly window',
        remain: 80,
        limit: 100,
        unit: '%',
        resetsAt: '2026-09-28T00:00:00.000Z',
      },
      {
        id: 'monthly',
        label: 'Monthly window',
        remain: 62,
        limit: 100,
        unit: '%',
        resetsAt: '2026-10-12T14:16:37.000Z',
      },
    ])
  })

  it('handles empty or missing windows gracefully', async () => {
    stubFetch({
      'https://opencode.ai/zen/go/v1/usage': {
        body: { usage: {} },
      },
    })
    const snapshot = await opencodeUsage({ provider: 'opencode-go', apiKey: 'sk-test' })
    expect(snapshot.windows).toEqual([])
    expect(snapshot.error).toBe('the usage endpoint reported no quota windows')
  })
})
