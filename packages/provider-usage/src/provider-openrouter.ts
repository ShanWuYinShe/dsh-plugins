/**
 * provider-openrouter.ts — openrouter 的额度查询器。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-openrouter
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, rec, getJson, trimBase } from './provider-shared.js'

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
