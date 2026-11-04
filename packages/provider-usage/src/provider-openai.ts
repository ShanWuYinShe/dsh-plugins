/**
 * provider-openai.ts — OpenAI / OneAPI / NewAPI 的额度查询器。
 *
 * @module @chaoset/provider-usage/provider-openai
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, str, rec, snapshotOf, getJson, trimBase } from './provider-shared.js'

/**
 * OpenAI / OneAPI / NewAPI billing subscription and balance.
 *
 * Checks `GET {base}/dashboard/billing/subscription` (or `/v1/...`) and optionally
 * `GET {base}/dashboard/billing/usage`.
 */
export const openaiUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return snapshotOf('openai', [])
  const root = trimBase(baseURL ?? 'https://api.openai.com')
  const headers = { authorization: `Bearer ${apiKey}` }
  let sub: Record<string, unknown>
  try {
    sub = await getJson(`${root}/dashboard/billing/subscription`, headers, signal)
  } catch {
    sub = await getJson(`${root}/v1/dashboard/billing/subscription`, headers, signal)
  }

  const windows: UsageWindow[] = []
  const planTitle = str(rec(sub['plan'])['title'])

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
    // 用量接口失败时不得把 hard_limit 当余额：那会把「已用掉一部分」显示成
    // 「满额」，与「不猜值」的口径相反。拿不到用量就只报上限——remain 缺席
    // 表示「余额未知」，client 已按该语义渲染（不画进度条、不显示 0）。
    let usageCost: number | undefined
    try {
      const now = new Date()
      const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
      const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const usageRes = await getJson(`${root}/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, headers, signal)
        .catch(() => getJson(`${root}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, headers, signal))
      const totalUsageCents = num(usageRes['total_usage'])
      if (totalUsageCents !== undefined) usageCost = totalUsageCents / 100
    } catch {
      // Usage endpoint unavailable: remain stays absent rather than claiming hardLimit.
    }
    windows.push({
      id: 'balance',
      label: 'Balance',
      ...usageCost === undefined ? {} : { remain: Math.max(0, hardLimit - usageCost) },
      limit: hardLimit,
      unit: 'usd',
      ...resetsAt !== undefined ? { resetsAt } : {},
    })
  }

  return snapshotOf('openai', windows, {
    plan: planTitle,
    error: 'the billing subscription endpoint reported no quota',
  })
}
