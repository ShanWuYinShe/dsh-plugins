/**
 * provider-openrouter.ts — OpenRouter 的额度查询器。
 *
 * @module @chaoset/provider-usage/provider-openrouter
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, rec, snapshotOf, getJson, joinRoot, trimBase } from './provider-shared.js'

/**
 * OpenRouter's credit balance.
 *
 * `/api/v1/credits` reports lifetime totals, so remaining is a subtraction;
 * `/api/v1/key` reports the calling key's own limit and is preferred when it
 * carries one, because a key-scoped limit is what the user configured.
 */
export const openrouterUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return snapshotOf('openrouter', [])
  const root = trimBase(baseURL ?? 'https://openrouter.ai/api')
  const headers = { authorization: `Bearer ${apiKey}` }
  const windows: UsageWindow[] = []

  // Key-scoped limit first: it answers "what can this key still spend".
  try {
    const key = rec((await getJson(joinRoot(root, '/v1/key'), headers, signal))['data'])
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

  const credits = rec((await getJson(joinRoot(root, '/v1/credits'), headers, signal))['data'])
  const total = num(credits['total_credits'])
  const used = num(credits['total_usage'])
  if (total !== undefined) {
    windows.push({
      id: 'account',
      label: 'Account credits',
      // 用量字段缺席时不能按 0 假定（那会把已花费显示成满额）：只报上限，
      // remain 缺席 = 余额未知。
      ...used === undefined ? {} : { remain: Math.max(0, total - used) },
      unit: 'credits',
      limit: total,
    })
  }

  return snapshotOf('openrouter', windows, { error: 'the credits endpoint reported no usable balance' })
}
