/**
 * provider-moonshot.ts — moonshot 的额度查询器。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-moonshot
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, rec, getJson, joinRoot, trimBase } from './provider-shared.js'

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
  const body = await getJson(joinRoot(root, '/v1/users/me/balance'), { authorization: `Bearer ${apiKey}` }, signal)
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
