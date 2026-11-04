/**
 * fetch-snapshot.ts — usage 路由取数（fetch + 包形解析）。
 *
 * 写回（保旧值、标 stale、provider 核对）留在 useProviderUsage：手动刷新与
 * resource 流共用这里的一次 GET。
 *
 * @module provider-usage/fetch-snapshot
 */

import { PROVIDER_USAGE_PATH, type ProviderUsageAnswer, type UsageSnapshot } from '../src/types.js'

/** 路由返回的一行答案：快照，或未注册标记（线协议类型定义在 src/types.ts）。 */
export type SnapshotAnswer = ProviderUsageAnswer

/** 路由答案是否是真实快照（而非「该 provider 未注册查询器」标记）。 */
export function isQueriedAnswer(answer: SnapshotAnswer | undefined): answer is UsageSnapshot {
  return answer !== undefined && !('queried' in answer)
}

/** 拉取一行答案；非 2xx 或形状不对都抛错（调用方决定保旧值还是失败）。 */
export async function fetchSnapshot(provider: string, signal?: AbortSignal, options?: { force?: boolean }): Promise<SnapshotAnswer | undefined> {
  // force 追加 refresh=1:手动刷新绕过宿主缓存;resource 流的自动轮询不带。
  const suffix = options?.force === true ? '&refresh=1' : ''
  const response = await fetch(`${PROVIDER_USAGE_PATH}?providers=${encodeURIComponent(provider)}${suffix}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  const value: unknown = await response.json().catch(() => undefined)
  const first = (value as { snapshots?: unknown } | null)?.snapshots
  const snapshot = Array.isArray(first) ? first[0] as SnapshotAnswer | undefined : undefined
  if (snapshot !== undefined && (snapshot === null || typeof snapshot !== 'object')) {
    throw new Error('unexpected usage payload')
  }
  return snapshot
}
