/**
 * session-query-bridge.ts — sessionQuery 可选服务的唯一探测入口。
 *
 * 2026-10-10 从 archive-host-context.ts 抽出：此前该模块直接 import 官方
 * `SessionQueryEngine` / `SessionTitleObservationResult` 类型并内联一段
 * IIFE 探测。抽出的动因是「类型来源」与「探测语义」两件事原先混在一处，
 * 官方契约漂移会直接渗进 host 上下文；现在官方类型只在本模块出现，
 * 调用方只依赖下面这个**自有的最小契约**。
 *
 * 契约（有意与官方 d.ts 解耦，仅保留本插件真正消费的形状）：
 * - 探测成功 → 返回 `(ids) => Promise<readonly unknown[]>`；
 * - 服务缺席 / 形状不符 / 探测抛错 → 返回 `undefined`，
 *   调用方据此逐行回退直读（见 readTitlesBulk）。
 *
 * 为什么探测走 ctx.get 而非 inject：真实 ctx 是 Proxy，未声明 inject 的
 * 服务直接读属性即抛 cannot get property without inject（dsh web 启动实测），
 * 只有 get() 会对缺席服务返回 undefined。而本插件不能把 sessionQuery 写进
 * inject——非 web 系 profile 未必挂载该服务，声明为必填即启动失败。
 *
 * @module @chaoset/session-archive/session-query-bridge
 */

import type { SessionQueryEngine, SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'

/** 批量标题查询函数：吃一组 id，返回逐 id 的观测结果（失败的 id 由调用方回退直读）。 */
export type SessionQueryTitles = (
  ids: readonly string[],
) => Promise<readonly SessionTitleObservationResult[]>

/** 官方服务键。抽成常量是为了让注入面与测试桩用同一处字面量。 */
export const SESSION_QUERY_SERVICE = 'sessionQuery'

/**
 * 运行时探测 sessionQuery 的批量标题能力。
 *
 * @param get - `ctx.get` 的绑定；极简 ctx 可能连 get 都没有，故取可选。
 * @returns 批量读标题的函数；服务缺席或形状不符时 `undefined`（调用方回退直读）。
 */
export function resolveSessionQueryTitles(
  get: unknown,
): SessionQueryTitles | undefined {
  if (typeof get !== 'function') return undefined
  let query: unknown
  try {
    query = (get as (name: string) => unknown)(SESSION_QUERY_SERVICE)
  } catch {
    // get 本身抛错（极简 ctx / 代理语义变化）：照样回退。
    // 可选探测永远不得连累 host 主逻辑。
    return undefined
  }
  if (query === null || typeof query !== 'object') return undefined
  const read = (query as Partial<SessionQueryEngine>).readTitleSnapshots
  if (typeof read !== 'function') return undefined
  const engine = query as SessionQueryEngine
  return (ids) => engine.readTitleSnapshots(ids as Parameters<SessionQueryEngine['readTitleSnapshots']>[0])
}
