/**
 * provider-minimax.ts — minimax 的额度查询器。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-minimax
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, rec, getJson, joinRoot, trimBase } from './provider-shared.js'

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
  const body = await getJson(joinRoot(root, '/v1/token_plan/remains'), headers, signal)
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
