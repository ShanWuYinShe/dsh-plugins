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
 */
export const deepseekUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'deepseek', windows: [], fetchedAt: Date.now() }
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
])
