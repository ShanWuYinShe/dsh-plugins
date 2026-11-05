/**
 * pill-rate-limit-scope.ts — 限流观测与「当前选中模型」的归属判定 + 紧迫度排序。
 *
 * 上游的限流是**按模型**的（WorkBuddy 的各模型 cap-hit 以 modelId 为键落盘），
 * 台账因此按 provider + model + policy 记录；wire 携带该 provider 的**全部**活跃
 * 观测（rateLimits 逐模型数组），这样切回先前被限的模型时它的限流信息不会丢。
 * 但展示面严格只显示**当前选中模型**那一条（没有就不显示）——选择哪个模型就
 * 看哪个模型，不罗列其它模型。
 *
 * 用户看到的语义必须与选中项一致：换了同一 provider 下的另一个模型之后，
 * 原先那个模型被限的事实不该继续挂在 pill 上——那会把「A 被限」误读成
 * 「整个 provider 不能用」，而新模型其实完全可用。
 *
 * 同一模型可能有多条策略（RPM / TPM / 日额度）同时被限：wire 里一条策略一条
 * 观测，这里按紧迫度挑「最该让用户看到」的那条（余量已耗尽 > 恢复更早 >
 * 最近被拒）。绝不把多条策略压成一条含混的「被限了」。
 *
 * @module provider-usage/pill-rate-limit-scope
 */

import type { UsageRateLimit, UsageSnapshot } from '../src/types.js'

/** 无限大的哨兵：用于「没有重置时刻」排在有时刻的后面。 */
const UNKNOWN_RESET = Number.POSITIVE_INFINITY

/**
 * 比较两条限流观测的紧迫度（返回值 < 0 表示 left 更该显示）。
 *
 * 排序口径（越靠前越紧迫）：
 * 1. 余量已耗尽（remaining === 0）的优先——它是这次拒绝的直接解释；
 * 2. 有明确恢复时刻的优先，且恢复越早越靠前（用户等得越少）；
 * 3. 余量更少的靠前（remaining 未知视为无限）；
 * 4. 最近被拒时间更新的靠前（同紧迫度下取新鲜事实）。
 *
 * @param left - 一条限流观测。
 * @param right - 另一条限流观测。
 * @returns 负数表示 left 更紧迫，正数表示 right 更紧迫，0 表示等价。
 */
export function compareRateLimitUrgency(left: UsageRateLimit, right: UsageRateLimit): number {
  const exhausted = (limit: UsageRateLimit): number => limit.remaining === 0 ? 0 : 1
  if (exhausted(left) !== exhausted(right)) return exhausted(left) - exhausted(right)
  const leftReset = left.resetAt ?? UNKNOWN_RESET
  const rightReset = right.resetAt ?? UNKNOWN_RESET
  if (leftReset !== rightReset) return leftReset - rightReset
  const leftRemaining = left.remaining ?? UNKNOWN_RESET
  const rightRemaining = right.remaining ?? UNKNOWN_RESET
  if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining
  if (left.lastSeenAt !== right.lastSeenAt) return right.lastSeenAt - left.lastSeenAt
  return 0
}

/** 从一组候选里挑最紧迫的一条（不修改入参）。 */
function mostUrgent(candidates: readonly UsageRateLimit[]): UsageRateLimit | undefined {
  let best: UsageRateLimit | undefined
  for (const candidate of candidates) {
    if (best === undefined || compareRateLimitUrgency(candidate, best) < 0) best = candidate
  }
  return best
}

/**
 * 从快照里挑出「当前选中模型」应展示的那一条限流观测（头行、圆点、面板共用）。
 *
 * 归属口径：
 * - 当前模型已知 → 只认模型 id **精确相等**的那几条（只比 id，不做大小写/前后缀
 *   模糊匹配），多条策略时取最紧迫的一条；没有精确命中时，才退到「不带 model 的
 *   provider 级观测」——上游没给模型维度时无法排除归属，宁可提示一条真实限流
 *   也不藏。
 * - 当前模型未知（目录尚未解析、无会话）→ 不做推断，按 provider 级事实取
 *   最靠前一条（保持既有语义）。
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
  const exact = limits.filter(limit => limit.model === currentModel)
  if (exact.length > 0) return mostUrgent(exact)
  return mostUrgent(limits.filter(limit => limit.model === undefined))
}
