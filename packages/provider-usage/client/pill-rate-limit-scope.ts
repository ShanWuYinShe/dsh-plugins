/**
 * pill-rate-limit-scope.ts — 限流观测与「当前选中模型」的归属判定。
 *
 * 上游的限流是**按模型**的（WorkBuddy 的各模型 cap-hit 以 modelId 为键落盘）。
 * 台账因此按 provider + model 记录，但 pill 是 provider 级表面：它的地址只带
 * provider，取回的是该 provider「最近一次活跃观测」。
 *
 * 用户看到的语义必须与选中项一致：换了同一 provider 下的另一个模型之后，
 * 原先那个模型被限的事实不该继续挂在 pill 上——那会把「A 被限」误读成
 * 「整个 provider 不能用」，而新模型其实完全可用。
 *
 * 因此渲染层按当前选中模型过滤：
 * - 观测带 model 且与当前模型不同 → 不属于当前选中项，不展示。
 * - 观测带 model 且与当前模型相同 → 展示。
 * - 观测不带 model（上游没给模型维度）→ 无法判定归属，按 **provider 级**
 *   事实展示：宁可提示一条真实存在的限流，也不把它藏起来。
 * - 当前模型未知（目录尚未解析、无会话）→ 同上，维持 provider 级展示。
 *
 * @module provider-usage/pill-rate-limit-scope
 */

import type { UsageRateLimit } from '../src/types.js'

/**
 * 判定一份限流观测是否属于当前选中的模型。
 *
 * @param rateLimit - 观测到的限流块（可能缺失）。
 * @param currentModel - 当前选中的模型 id；未知时传 undefined。
 * @returns 应当在 pill 上展示的限流块；不属于当前模型时为 undefined。
 */
export function rateLimitForCurrentModel(
  rateLimit: UsageRateLimit | undefined,
  currentModel: string | undefined,
): UsageRateLimit | undefined {
  if (rateLimit === undefined) return undefined
  // 上游没给模型维度：这是 provider 级观测，无法排除它正属于当前模型。
  if (rateLimit.model === undefined) return rateLimit
  // 当前模型未知（目录未解析/无会话）：不做推断，保持既有展示。
  if (currentModel === undefined || currentModel === '') return rateLimit
  return rateLimit.model === currentModel ? rateLimit : undefined
}
