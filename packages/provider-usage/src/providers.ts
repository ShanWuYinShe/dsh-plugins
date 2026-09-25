/**
 * Built-in usage queriers for providers whose billing endpoint is public and
 * documented.
 *
 * These are conveniences, not the mechanism: the harness has no provider-quota
 * seam, so genericity comes from {@link ProviderUsageRegistry.register} — any
 * plugin can contribute a querier for a provider it owns. Built-ins exist so
 * the common routes work without configuration, and each one is deliberately
 * tolerant: providers rename fields between versions, and a querier that
 * guesses wrong must report "nothing to show" rather than a wrong balance.
 *
 * @module provider-usage/providers
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'

/** Read a finite number from either a JSON number or a numeric string. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Read a non-empty string. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read a nested record, or an empty one so callers can chain reads safely. */
function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Read an array of records, dropping entries that are not records. */
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) as Record<string, unknown>[] : []
}

/** GET a JSON document, failing loud on a non-2xx so the registry can report it. */
async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    ...signal === undefined ? {} : { signal },
  })
  const text = await response.text()
  if (!response.ok) {
    // The body may quote the credential it rejected; the registry redacts
    // before this crosses to the browser, but keep the excerpt short anyway.
    throw new Error(`${new URL(url).host} responded ${response.status}: ${text.slice(0, 160)}`)
  }
  try {
    return rec(JSON.parse(text))
  } catch {
    throw new Error(`${new URL(url).host} returned a non-JSON body`)
  }
}

/** Trim trailing slashes so a configured baseURL joins cleanly. */
function trimBase(baseURL: string): string {
  return baseURL.replace(/\/+$/u, '')
}

/** Share one balance reading per credential across a single snapshot build. */
interface BalanceReader {
  (): Promise<Record<string, unknown>>
}

/**
 * DeepSeek's prepaid balance.
 *
 * `GET {base}/user/balance` answers `balance_infos[]`, one entry per
 * currency, each carrying string amounts. A multi-currency account gets one
 * window per currency so the surface never adds unlike units together.
 *
 * Without an API key the OAuth account wallets (resolve layer) are the
 * fallback: one window per currency with recharge + bonus summed, the same
 * shape as the API path so the pill renders identically whichever auth the
 * user has. The API path wins whenever a key exists — a single source
 * answers, never double-counted.
 */
export const deepseekUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal, accountWallets, accountError }) => {
  if (apiKey === undefined) {
    if (accountError !== undefined) return { provider: 'deepseek', windows: [], fetchedAt: Date.now(), error: accountError }
    if (accountWallets !== undefined) {
      const windows: UsageWindow[] = []
      for (const wallet of accountWallets) {
        const remain = wallet.recharge + wallet.bonus
        windows.push({ id: `account-${wallet.currency}`, label: wallet.currency, remain, unit: wallet.currency.toLowerCase() })
      }
      return {
        provider: 'deepseek',
        windows,
        fetchedAt: Date.now(),
        ...windows.length === 0 ? { error: 'the account reports no usable balance' } : {},
      }
    }
    return { provider: 'deepseek', windows: [], fetchedAt: Date.now() }
  }
  const root = trimBase(baseURL ?? 'https://api.deepseek.com')
  const body = await getJson(`${root}/user/balance`, { authorization: `Bearer ${apiKey}` }, signal)
  const windows: UsageWindow[] = []
  for (const info of records(body['balance_infos'])) {
    const currency = str(info['currency']) ?? 'CNY'
    const remain = num(info['total_balance'])
    if (remain === undefined) continue
    windows.push({ id: `balance-${currency}`, label: currency, remain, unit: currency.toLowerCase() })
  }
  return {
    provider: 'deepseek',
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the balance endpoint reported no usable balance' } : {},
  }
}

/**
 * OpenRouter's credit balance.
 *
 * `/api/v1/credits` reports lifetime totals, so remaining is a subtraction;
 * `/api/v1/key` reports the calling key's own limit and is preferred when it
 * carries one, because a key-scoped limit is what the user configured.
 */
export const openrouterUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'openrouter', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://openrouter.ai/api')
  const headers = { authorization: `Bearer ${apiKey}` }
  const windows: UsageWindow[] = []

  // Key-scoped limit first: it answers "what can this key still spend".
  try {
    const key = rec((await getJson(`${root}/v1/key`, headers, signal))['data'])
    const remaining = num(key['limit_remaining'])
    const limit = num(key['limit'])
    if (remaining !== undefined) {
      windows.push({
        id: 'key',
        label: 'API key',
        remain: remaining,
        unit: 'credits',
        ...limit === undefined ? {} : { limit },
      })
    }
  } catch {
    // A key with no explicit limit legitimately has none to report; the
    // account-level credits below are the answer in that case.
  }

  const credits = rec((await getJson(`${root}/v1/credits`, headers, signal))['data'])
  const total = num(credits['total_credits'])
  const used = num(credits['total_usage'])
  if (total !== undefined) {
    windows.push({
      id: 'account',
      label: 'Account credits',
      remain: Math.max(0, total - (used ?? 0)),
      unit: 'credits',
      limit: total,
    })
  }

  return {
    provider: 'openrouter',
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the credits endpoint reported no usable balance' } : {},
  }
}

/**
 * Moonshot (Kimi)'s balance.
 *
 * `GET {base}/v1/users/me/balance` answers `data.available_balance` with
 * voucher and cash split out; the cash figure is reported alongside when it
 * differs from the total, so the bar's total is explainable.
 */
export const moonshotUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'moonshot', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://api.moonshot.cn')
  const body = await getJson(`${root}/v1/users/me/balance`, { authorization: `Bearer ${apiKey}` }, signal)
  const data = rec(body['data'])
  const windows: UsageWindow[] = []
  const available = num(data['available_balance'])
  if (available !== undefined) {
    windows.push({ id: 'available', label: 'Available balance', remain: available, unit: 'cny' })
  }
  const cash = num(data['cash_balance'])
  if (cash !== undefined && cash > 0 && cash !== available) {
    windows.push({ id: 'cash', label: 'Cash balance', remain: cash, unit: 'cny' })
  }
  const voucher = num(data['voucher_balance'])
  if (voucher !== undefined && voucher > 0) {
    windows.push({ id: 'voucher', label: 'Voucher', remain: voucher, unit: 'cny' })
  }
  return {
    provider: 'moonshot',
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the balance endpoint reported no usable balance' } : {},
  }
}

/**
 * SiliconFlow's prepaid account balance.
 *
 * `GET {base}/v1/user/info` returns `data.totalBalance`, `data.balance`, and `data.chargeBalance`.
 */
export const siliconflowUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'siliconflow', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://api.siliconflow.cn')
  const body = await getJson(`${root}/v1/user/info`, { authorization: `Bearer ${apiKey}` }, signal)
  const data = rec(body['data'])
  const windows: UsageWindow[] = []
  const total = num(data['totalBalance'])
  if (total !== undefined) {
    windows.push({ id: 'total', label: 'Total balance', remain: total, unit: 'cny' })
  }
  const balance = num(data['balance'])
  if (balance !== undefined && balance !== total) {
    windows.push({ id: 'balance', label: 'Available balance', remain: balance, unit: 'cny' })
  }
  const charge = num(data['chargeBalance'])
  if (charge !== undefined && charge > 0 && charge !== total) {
    windows.push({ id: 'charge', label: 'Recharge balance', remain: charge, unit: 'cny' })
  }
  return {
    provider: 'siliconflow',
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the user info endpoint reported no usable balance' } : {},
  }
}

/**
 * BigModel (Zhipu AI) Coding Plan and subscription quota.
 *
 * First checks `GET {base}/api/monitor/usage/quota/limit`, which returns rolling
 * 5-hour and weekly limits. If unavailable or empty, falls back to
 * `GET https://bigmodel.cn/api/biz/subscription/list`.
 */
export const bigmodelUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'bigmodel', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://open.bigmodel.cn')
  const headers = { authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}` }
  const windows: UsageWindow[] = []
  let plan: string | undefined

  try {
    const body = await getJson(`${root}/api/monitor/usage/quota/limit`, headers, signal)
    const data = rec(body['data'])
    const limits = records(data['limits'])
    for (const lim of limits) {
      const type = str(lim['type']) ?? 'QUOTA'
      const percentage = num(lim['percentage'])
      const nextReset = num(lim['nextResetTime'])
      const label = type === 'TOKENS_LIMIT' ? 'Token limit' : type === 'TIME_LIMIT' ? 'Time limit' : type
      if (percentage !== undefined) {
        const remain = Math.max(0, 100 - percentage)
        windows.push({
          id: type.toLowerCase(),
          label,
          remain,
          limit: 100,
          unit: '%',
          ...nextReset !== undefined && nextReset > 0 ? { resetsAt: new Date(nextReset).toISOString() } : {},
        })
      }
    }
    if (windows.length > 0) plan = 'Coding Plan'
  } catch {
    // Coding Plan endpoint not reachable or not supported on this account
  }

  if (windows.length === 0) {
    try {
      const body = await getJson('https://bigmodel.cn/api/biz/subscription/list', headers, signal)
      const list = records(rec(body['data'])['list'])
      for (const item of list) {
        const status = str(item['status'])
        const productName = str(item['productName']) ?? 'Subscription'
        const expireTime = str(item['expireTime'])
        if (status === 'VALID') {
          plan = productName
          windows.push({
            id: `sub-${productName.toLowerCase().replace(/\s+/g, '-')}`,
            label: productName,
            unit: 'VALID',
            ...expireTime !== undefined ? { resetsAt: expireTime } : {},
          })
        }
      }
    } catch {
      // Subscription list not available
    }
  }

  return {
    provider: 'bigmodel',
    ...plan === undefined ? {} : { plan },
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the quota endpoint reported no usable quota or subscription' } : {},
  }
}

/**
 * MiniMax Token Plan quota.
 *
 * `GET {base}/v1/token_plan/remains` returns 5-hour rolling interval and weekly
 * window token counters and percentages.
 */
export const minimaxUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'minimax', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://api.minimaxi.com')
  const headers = { authorization: `Bearer ${apiKey}` }
  const body = await getJson(`${root}/v1/token_plan/remains`, headers, signal)
  const data = rec(body['data'])
  const windows: UsageWindow[] = []

  const intervalRemainPct = num(body['current_interval_remaining_percent'] ?? data['current_interval_remaining_percent'])
  const intervalTotal = num(body['current_interval_total_count'] ?? data['current_interval_total_count'])
  const intervalUsage = num(body['current_interval_usage_count'] ?? data['current_interval_usage_count'])
  if (intervalTotal !== undefined && intervalUsage !== undefined) {
    windows.push({
      id: 'interval',
      label: 'Rolling window (5h)',
      remain: Math.max(0, intervalTotal - intervalUsage),
      limit: intervalTotal,
      unit: 'tokens',
    })
  } else if (intervalRemainPct !== undefined) {
    windows.push({
      id: 'interval',
      label: 'Rolling window (5h)',
      remain: intervalRemainPct,
      limit: 100,
      unit: '%',
    })
  }

  const weeklyRemainPct = num(body['current_weekly_remaining_percent'] ?? data['current_weekly_remaining_percent'])
  const weeklyTotal = num(body['current_weekly_total_count'] ?? data['current_weekly_total_count'])
  const weeklyUsage = num(body['current_weekly_usage_count'] ?? data['current_weekly_usage_count'])
  if (weeklyTotal !== undefined && weeklyUsage !== undefined) {
    windows.push({
      id: 'weekly',
      label: 'Weekly window',
      remain: Math.max(0, weeklyTotal - weeklyUsage),
      limit: weeklyTotal,
      unit: 'tokens',
    })
  } else if (weeklyRemainPct !== undefined) {
    windows.push({
      id: 'weekly',
      label: 'Weekly window',
      remain: weeklyRemainPct,
      limit: 100,
      unit: '%',
    })
  }

  return {
    provider: 'minimax',
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the token plan endpoint reported no usable window' } : {},
  }
}

/**
 * OpenAI / OneAPI / NewAPI billing subscription and balance.
 *
 * Checks `GET {base}/dashboard/billing/subscription` (or `/v1/...`) and optionally
 * `GET {base}/dashboard/billing/usage`.
 */
export const openaiUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'openai', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://api.openai.com')
  const headers = { authorization: `Bearer ${apiKey}` }
  let sub: Record<string, unknown> = {}
  try {
    sub = await getJson(`${root}/dashboard/billing/subscription`, headers, signal)
  } catch {
    sub = await getJson(`${root}/v1/dashboard/billing/subscription`, headers, signal)
  }

  const windows: UsageWindow[] = []
  let planTitle: string | undefined
  const plan = rec(sub['plan'])
  if (str(plan['title'])) planTitle = str(plan['title'])

  const hardLimit = num(sub['hard_limit_usd'] ?? sub['system_hard_limit_usd'] ?? sub['max_budget'])
  const totalAvailable = num(sub['total_available'])
  const accessUntil = num(sub['access_until'])
  const resetsAt = accessUntil !== undefined && accessUntil > 0 ? new Date(accessUntil * 1000).toISOString() : undefined

  if (totalAvailable !== undefined) {
    windows.push({
      id: 'balance',
      label: 'Balance',
      remain: totalAvailable,
      unit: 'usd',
      ...hardLimit !== undefined ? { limit: hardLimit } : {},
      ...resetsAt !== undefined ? { resetsAt } : {},
    })
  } else if (hardLimit !== undefined) {
    let usageCost = 0
    try {
      const now = new Date()
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const usageRes = await getJson(`${root}/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, headers, signal)
        .catch(() => getJson(`${root}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, headers, signal))
      const totalUsageCents = num(usageRes['total_usage'])
      if (totalUsageCents !== undefined) {
        usageCost = totalUsageCents / 100
      }
    } catch {
      // Usage endpoint unavailable, balance equals hardLimit
    }
    windows.push({
      id: 'balance',
      label: 'Balance',
      remain: Math.max(0, hardLimit - usageCost),
      limit: hardLimit,
      unit: 'usd',
      ...resetsAt !== undefined ? { resetsAt } : {},
    })
  }

  return {
    provider: 'openai',
    ...planTitle === undefined ? {} : { plan: planTitle },
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the billing subscription endpoint reported no quota' } : {},
  }
}

/**
 * OpenCode / OpenCode Go usage (rolling 5h, weekly, and monthly quota windows).
 *
 * `GET {base}/usage` returns current usage percentages and reset timestamps.
 */
export const opencodeUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'opencode-go', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://opencode.ai/zen/go/v1')
  const headers = { authorization: `Bearer ${apiKey}` }
  let body: Record<string, unknown> = {}
  // 回退路径只对未带 /v1 的自定义 baseURL 追加 /v1:默认 root 已含 /v1,
  // 再拼 /v1/usage 是必然 404 的死请求,还会把真正的首请求错误盖成 404。
  const fallbackPath = root.endsWith('/v1') ? '/usage' : '/v1/usage'
  try {
    body = await getJson(`${root}/usage`, headers, signal)
  } catch {
    body = await getJson(`${root}${fallbackPath}`, headers, signal)
  }
  const usage = rec(body['usage'])
  const windows: UsageWindow[] = []

  const windowDefs = [
    { key: 'rolling', label: 'Rolling window (5h)' },
    { key: 'weekly', label: 'Weekly window' },
    { key: 'monthly', label: 'Monthly window' },
  ] as const

  for (const { key, label } of windowDefs) {
    const item = rec(usage[key])
    const usedPct = num(item['percent'])
    const resetsAt = str(item['resetsAt'])
    if (usedPct !== undefined) {
      const remain = Math.max(0, 100 - usedPct)
      windows.push({
        id: key,
        label,
        remain,
        limit: 100,
        unit: '%',
        ...resetsAt !== undefined ? { resetsAt } : {},
      })
    }
  }

  return {
    provider: 'opencode-go',
    plan: 'OpenCode Go',
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the usage endpoint reported no quota windows' } : {},
  }
}

/**
 * Every built-in querier, keyed by provider route.
 *
 * Registering these is opt-out by omission: a deployment that wants different
 * behaviour for one of these routes registers its own querier afterwards and
 * wins, because a later registration replaces an earlier one.
 *
 * WorkBuddy's two routes are deliberately absent: this package has no way to
 * read that desktop app's credential, and the plugin that owns those routes
 * (`@chaoset/dsh-any-connect`) registers its own querier against the billing
 * endpoint it already talks to. That is the intended shape — the provider's
 * owner is the right place to know its billing API.
 */
export const BUILTIN_USAGE_QUERIERS: ReadonlyMap<string, { querier: ProviderUsageQuerier; displayName: string }> = new Map([
  ['deepseek', { querier: deepseekUsage, displayName: 'DeepSeek' }],
  ['openrouter', { querier: openrouterUsage, displayName: 'OpenRouter' }],
  ['moonshot', { querier: moonshotUsage, displayName: 'Moonshot' }],
  ['siliconflow', { querier: siliconflowUsage, displayName: 'SiliconFlow' }],
  ['bigmodel', { querier: bigmodelUsage, displayName: 'BigModel' }],
  ['minimax', { querier: minimaxUsage, displayName: 'MiniMax' }],
  ['openai', { querier: openaiUsage, displayName: 'OpenAI / OneAPI' }],
  ['opencode', { querier: opencodeUsage, displayName: 'OpenCode' }],
  ['opencode-go', { querier: opencodeUsage, displayName: 'OpenCode Go' }],
])
