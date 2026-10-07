/**
 * provider-siliconflow.ts — siliconflow 的额度查询器。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-siliconflow
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, rec, getJson, trimBase } from './provider-shared.js'

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
