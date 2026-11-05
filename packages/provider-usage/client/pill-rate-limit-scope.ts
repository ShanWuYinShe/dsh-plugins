/**
 * pill-rate-limit-scope.ts — 限流观测与「当前选中模型」的归属判定。
 *
 * 上游的限流是**按模型**的（WorkBuddy 的各模型 cap-hit 以 modelId 为键落盘），
 * 台账因此按 provider + model 记录；wire 携带该 provider 的**全部**活跃观测
 * （`rateLimits` 逐模型数组），这样切回先前被限的模型时它的限流信息不会丢。
 * 但展示面严格只显示**当前选中模型**那一条（没有就不显示）——选择哪个模型就
 * 看哪个模型，不罗列其它模型。
 *
 * 用户看到的语义必须与选中项一致：换了同一 provider 下的另一个模型之后，
 * 原先那个模型被限的事实不该继续挂在 pill 上——那会把「A 被限」误读成
 * 「整个 provider 不能用」，而新模型其实完全可用。
 *
 * @module provider-usage/pill-rate-limit-scope
 */

import type { UsageRateLimit, UsageSnapshot } from '../src/types.js'

/**
 * 从快照里挑出「当前选中模型」应展示的那一条限流观测（头行、圆点、面板共用）。
 *
 * 归属口径：
 * - 当前模型已知 → 只认模型 id **精确相等**的那条（只比 id，不做大小写/前后缀
 *   模糊匹配）；没有精确命中时，才退到「不带 model 的 provider 级观测」——上游
 *   没给模型维度时无法排除归属，宁可提示一条真实限流也不藏。
 * - 当前模型未知（目录尚未解析、无会话）→ 不做推断，按 provider 级事实取
 *   最靠前一条。
 *
 * @param snapshot - 资源流答案里的快照；未查询时为 undefined。
 * @param currentModel - 当前选中的模型 id；未知时传 undefined。
 * @returns 当前选中模型应展示的观测；没被限（或 wire 缺失/形状非法）时 undefined。
 */
export function selectRateLimitForCurrentModel(
  snapshot: UsageSnapshot | undefined,
  currentModel: string | undefined,
): UsageRateLimit | undefined {
  if (snapshot === undefined) return undefined
  // Array.isArray 是纵深防御：host 已完整校验，但被中间层替换/破坏的帧也不该
  // 让渲染期抛错（RULE-040）。
  const limits = Array.isArray(snapshot.rateLimits) ? snapshot.rateLimits : []
  if (currentModel === undefined || currentModel === '') return limits[0]
  return limits.find(limit => limit.model === currentModel) ?? limits.find(limit => limit.model === undefined)
}
