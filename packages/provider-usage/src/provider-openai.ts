/**
 * provider-openai.ts — openai 的额度查询器。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-openai
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, str, rec, getJson, trimBase } from './provider-shared.js'

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
