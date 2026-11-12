/**
 * session-projection-bridge.ts — 官方持久化 projection 缓存（`ctx.sessionProjectionCache`）
 * 的唯一探测入口。
 *
 * 归档面板的列表标题此前走 `sessionQuery.readTitleSnapshots()`，官方实现会先
 * `persistence.list()` 再逐个 **整条读取会话日志**（`readColdSessionLog`）折
 * title——归档会话越多、日志越大，面板打开越慢（全量日志读 + JSON 解析）。
 * 宿主的官方会话列表对 cold 会话并不读日志：它读
 * `sessionProjectionCache.cachedSnapshot()` / `cachedPredecessorTitle()`，
 * 从 storageDomain 的内存表零 I/O 取 projection 值（title 是其一）。
 *
 * 本模块只做「探测 + 最小契约收窄」，不把官方 d.ts 漂移渗进 host 上下文：
 * - 服务缺席 / 形状不符 / 探测抛错 → 返回 `undefined`，调用方回落原有
 *   sessionQuery 批量标题 / 逐条直读；
 * - 每次读取都自带 try/catch：一个损坏的缓存行不得让整个列表失败。
 *
 * 为什么探测走 `ctx.get` 而非 inject：`sessionProjectionCache` 由
 * `@deepseek-ai/dsh-session-projection-cache` 提供，并非所有 profile 都挂载
 * （headless/SDK 可能没有）；声明为必填会让插件在这些部署上无法激活。
 *
 * @module @chaoset/session-archive/session-projection-bridge
 */

import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache'

/** 官方服务键（抽常量让注入面与测试桩共用同一处字面量）。 */
export const SESSION_PROJECTION_CACHE_SERVICE = 'sessionProjectionCache'

/**
 * 零 I/O 读取一个会话标题：命中缓存返回 `string`，缓存明确记录「无标题」
 * 返回 `null`，缓存里没有该会话/行不可用返回 `undefined`（调用方回落
 * 原有读路径）。
 */
export type CachedArchiveTitle = (header: SessionHeader) => string | null | undefined

/**
 * 探测官方持久化 projection 缓存。
 *
 * @param get - `ctx.get` 的绑定；极简 ctx 可能连 get 都没有，故取可选。
 * @returns 零 I/O 标题读取函数；服务缺席或形状不符时 `undefined`。
 */
export function resolveCachedArchiveTitle(get: unknown): CachedArchiveTitle | undefined {
  if (typeof get !== 'function') return undefined
  let cache: unknown
  try {
    cache = (get as (name: string) => unknown)(SESSION_PROJECTION_CACHE_SERVICE)
  } catch {
    // 探测本身抛错（极简 ctx / 代理语义变化）：照样回落。
    return undefined
  }
  if (cache === null || typeof cache !== 'object') return undefined
  const readSnapshot = (cache as Partial<SessionProjectionCache>).cachedSnapshot
  const readPredecessorTitle = (cache as Partial<SessionProjectionCache>).cachedPredecessorTitle
  if (typeof readSnapshot !== 'function' || typeof readPredecessorTitle !== 'function') return undefined
  const service = cache as SessionProjectionCache
  return (header) => {
    try {
      // 官方列表同款顺序：当前记录优先，跨 Session-format 代际的
      // predecessor 只暴露 title 一条（其其它 projection 语义不保证兼容）。
      const block = readSnapshot.call(service, header, ['title']) ?? readPredecessorTitle.call(service, header)
      if (block === undefined) return undefined
      const value = (block.values as { title?: unknown }).title
      if (typeof value === 'string') return value
      // null = 该会话在缓存记录里就是「无标题」，是有效事实；缺席 = 不可用。
      return value === null ? null : undefined
    } catch {
      // 缓存行损坏/版本不匹配：本次按未命中处理，不连累整表。
      return undefined
    }
  }
}
