/**
 * fetch-snapshot.ts — usage 路由取数（fetch + 包形解析）。
 *
 * useProviderUsage.refresh 原先包揽 fetch / 解析 / 保旧值写回三责，
 * 此处只做前两件：写回（保旧值、标 stale、provider 核对）仍留在 hook。
 *
 * @module provider-usage/fetch-snapshot
 */

import { PROVIDER_USAGE_PATH, type UsageSnapshot } from '../src/types.js'

/** 路由返回的一行答案：快照，或未注册标记。 */
export type SnapshotAnswer = UsageSnapshot | { provider: string; queried: false }

/** 拉取一行答案；非 2xx 或形状不对都抛错（调用方决定保旧值还是失败）。 */
export async function fetchSnapshot(provider: string, signal?: AbortSignal): Promise<SnapshotAnswer | undefined> {
  const response = await fetch(`${PROVIDER_USAGE_PATH}?providers=${encodeURIComponent(provider)}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...signal === undefined ? {} : { signal },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  const first = (value as { snapshots?: unknown } | null)?.snapshots
  const snapshot = Array.isArray(first) ? first[0] as SnapshotAnswer | undefined : undefined
  if (snapshot !== undefined && (snapshot === null || typeof snapshot !== 'object')) {
    throw new Error('unexpected usage payload')
  }
  return snapshot
}
