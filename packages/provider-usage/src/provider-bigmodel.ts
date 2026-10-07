/**
 * provider-bigmodel.ts — bigmodel 的额度查询器。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-bigmodel
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, str, rec, records, getJson, trimBase } from './provider-shared.js'

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
