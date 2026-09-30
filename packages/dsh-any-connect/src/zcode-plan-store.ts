/**
 * ZCode account-plan semantics, pinned per variant.
 *
 * ZCode Coding Plan 与 ZCode Start Plan 在本插件里是**两个独立的变体**（各自
 * 的模型分组、模型名单、额度池与通道），不是一个连接的两种模式。本模块只做
 * 一件事：把变体固定的计划语义折进读出的凭据，使 `credential.zcodePlan` 恒为
 * 该变体的计划——模型路由（专属 vs 普通通道）、额度来源、夜免资格都只看这
 * 一个字段。
 *
 * 2026-09-30 用户口径：两个计划的额度绝不混用。Start Plan 走专属通道
 * （`zcode-plan/anthropic` + 账号 JWT），扣其专属额度（一次性、当日有效的
 * token 包）；Coding Plan 走普通 ZCode 通道（150% 额度）扣订阅。
 *
 * @module dsh-any-connect/zcode-plan-store
 */

import type { ZCodePlanKind } from './auth.js'

/**
 * The plan in force for one variant's credential read.
 *
 * `start-plan` 槽位恒为 start-plan；`coding-plan` 槽位保留客户端选中的具体
 * coding 语义（individual/team），其余（start-plan / off-peak / 未知）一律归
 * 入抽象 coding——coding 变体绝不因客户端选中了账号计划而改走专属通道。
 */
export function effectiveZCodePlan(
  selection: ZCodePlanKind | undefined,
  override: 'coding-plan' | 'start-plan',
): ZCodePlanKind | 'coding-plan' {
  if (override === 'start-plan') return 'start-plan'
  if (selection === 'individual-coding-plan' || selection === 'team-coding-plan') return selection
  return 'coding-plan'
}

/**
 * Fold the variant's plan into a credential: after this, `zcodePlan` IS the
 * plan the variant serves.
 *
 * `coding-plan` is an abstract slot, not a client value: a credential already
 * carrying a concrete coding-plan kind keeps it; anything else falls to
 * `individual-coding-plan` (the key fallback prefers the individual key too,
 * so routing and billing stay consistent).
 */
export function applyZCodePlanOverride<C extends { zcodePlan?: ZCodePlanKind }>(credential: C, override: 'coding-plan' | 'start-plan'): C {
  const effective = effectiveZCodePlan(credential.zcodePlan, override)
  if (effective === credential.zcodePlan) return credential
  if (effective === 'start-plan') return { ...credential, zcodePlan: 'start-plan' }
  if (credential.zcodePlan === 'individual-coding-plan' || credential.zcodePlan === 'team-coding-plan') return credential
  return { ...credential, zcodePlan: 'individual-coding-plan' }
}

/**
 * Whether the plan in force gets the night-free window (a Coding Plan
 * benefit, never granted to Start Plan).
 */
export function isNightFreeEligiblePlan(plan: ZCodePlanKind | 'coding-plan' | undefined): boolean {
  return plan !== 'start-plan'
}
