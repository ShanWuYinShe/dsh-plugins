/**
 * provider-opencode.ts — opencode 的额度查询器。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-opencode
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, str, rec, getJson, trimBase } from './provider-shared.js'

/**
 * OpenCode / OpenCode Go usage (rolling 5h, weekly, and monthly quota windows).
 *
 * `GET {base}/usage` returns current usage percentages and reset timestamps.
 */
export const opencodeUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return { provider: 'opencode-go', windows: [], fetchedAt: Date.now() }
  const root = trimBase(baseURL ?? 'https://opencode.ai/zen/go/v1')
  const headers = { authorization: `Bearer ${apiKey}` }
  let body: Record<string, unknown> = {}
  // 回退路径只对未带 /v1 的自定义 baseURL 追加 /v1:默认 root 已含 /v1,
  // 再拼 /v1/usage 是必然 404 的死请求,还会把真正的首请求错误盖成 404。
  const fallbackPath = root.endsWith('/v1') ? '/usage' : '/v1/usage'
  try {
    body = await getJson(`${root}/usage`, headers, signal)
  } catch {
    body = await getJson(`${root}${fallbackPath}`, headers, signal)
  }
  const usage = rec(body['usage'])
  const windows: UsageWindow[] = []

  const windowDefs = [
    { key: 'rolling', label: 'Rolling window (5h)' },
    { key: 'weekly', label: 'Weekly window' },
    { key: 'monthly', label: 'Monthly window' },
  ] as const

  for (const { key, label } of windowDefs) {
    const item = rec(usage[key])
    const usedPct = num(item['percent'])
    const resetsAt = str(item['resetsAt'])
    if (usedPct !== undefined) {
      const remain = Math.max(0, 100 - usedPct)
      windows.push({
        id: key,
        label,
        remain,
        limit: 100,
        unit: '%',
        ...resetsAt !== undefined ? { resetsAt } : {},
      })
    }
  }

  return {
    provider: 'opencode-go',
    plan: 'OpenCode Go',
    windows,
    fetchedAt: Date.now(),
    ...windows.length === 0 ? { error: 'the usage endpoint reported no quota windows' } : {},
  }
}
