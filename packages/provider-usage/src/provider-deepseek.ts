/**
 * provider-deepseek.ts — DeepSeek 的额度查询器。
 *
 * @module @chaoset/provider-usage/provider-deepseek
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, records, snapshotOf, str, getJson, trimBase } from './provider-shared.js'

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
    if (accountError !== undefined) return snapshotOf('deepseek', [], { error: accountError })
    if (accountWallets !== undefined) {
      const windows: UsageWindow[] = accountWallets.map(wallet => ({
        id: `account-${wallet.currency}`,
        label: wallet.currency,
        remain: wallet.recharge + wallet.bonus,
        unit: wallet.currency.toLowerCase(),
      }))
      return snapshotOf('deepseek', windows, { error: 'the account reports no usable balance' })
    }
    return snapshotOf('deepseek', [])
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
  return snapshotOf('deepseek', windows, { error: 'the balance endpoint reported no usable balance' })
}
