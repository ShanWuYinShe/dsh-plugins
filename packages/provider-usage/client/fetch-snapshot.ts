/**
 * fetch-snapshot.ts — usage 路由取数（fetch + 包形解析）。
 *
 * 写回（保旧值、标 stale、provider 核对）留在 useProviderUsage：手动刷新与
 * resource 流共用这里的一次 GET。
 *
 * 解析只做**最小结构校验**（RULE-040 纵深防御）：同源 host 已按
 * registry.assertQuerierSnapshot 完整校验，但被中间层破坏/替换的响应也不能
 * 当成合法快照交给渲染层——形状不合法一律视为「无答案」（undefined），由
 * 调用方按既有语义保旧值/不推帧，而不是让它进渲染期抛错。
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

/** 普通对象判定：数组与 null 都不算。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 一份 route 答案是否满足 client 渲染所需的最小形状。
 *
 * - `provider` 必须与本次请求一致（同一地址的答案不得互串）；
 * - 「未注册」标记 `{provider, queried:false}` 合法（它没有 windows）；
 * - 快照必须有 `windows` 数组，`error` 若存在必须是字符串——这两项是
 *   pill 渲染直接读的字段（窗口列表、失败文案）。
 *
 * @param value - 线上答案的原始值。
 * @param provider - 本次请求的 provider 键。
 * @returns 是否是可用答案。
 */
function isSnapshotAnswer(value: unknown, provider: string): value is SnapshotAnswer {
  if (!isRecord(value)) return false
  if (value['provider'] !== provider) return false
  if (value['queried'] === false) return true
  if (!Array.isArray(value['windows'])) return false
  if (value['error'] !== undefined && typeof value['error'] !== 'string') return false
  return true
}

/**
 * 一次取数的结果：一行答案（或 undefined=无答案）+ 宿主成功缓存 TTL。
 *
 * `cacheTtlMs` 缺失（旧宿主 / 响应被中间层裁剪）时调用方回退默认节拍——它是
 * 排程提示，不是答案有效性的一部分。
 */
export interface UsageSnapshotFetch {
  /** 一行答案；形状不合法时为 undefined（按「无答案」处理）。 */
  answer: SnapshotAnswer | undefined
  /** 宿主 registry 的成功缓存时长（毫秒）；旧宿主没有该字段。 */
  cacheTtlMs: number | undefined
}

/** 拉取一行答案；非 2xx 抛错（调用方决定保旧值还是失败），形状不合法视为无答案。 */
export async function fetchSnapshot(provider: string, signal?: AbortSignal, options?: { force?: boolean }): Promise<UsageSnapshotFetch> {
  // force 追加 refresh=1:手动刷新绕过宿主缓存;resource 流的自动轮询不带。
  const suffix = options?.force === true ? '&refresh=1' : ''
  const response = await fetch(`${PROVIDER_USAGE_PATH}?providers=${encodeURIComponent(provider)}${suffix}`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw new Error(`HTTP_${response.status}`)
  const payload: unknown = await response.json().catch(() => undefined)
  const rawTtl = isRecord(payload) ? payload['cacheTtlMs'] : undefined
  const cacheTtlMs = typeof rawTtl === 'number' && Number.isFinite(rawTtl) && rawTtl >= 0 ? rawTtl : undefined
  const snapshots = isRecord(payload) ? payload['snapshots'] : undefined
  if (!Array.isArray(snapshots)) return { answer: undefined, cacheTtlMs }
  const first: unknown = snapshots[0]
  return { answer: isSnapshotAnswer(first, provider) ? first : undefined, cacheTtlMs }
}
