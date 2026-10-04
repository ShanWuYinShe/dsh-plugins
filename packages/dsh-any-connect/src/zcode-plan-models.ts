/**
 * ZCode Start Plan model roster: derived from the plan's own entitlements.
 *
 * The dedicated Start Plan channel is a separate product from Coding Plan (its
 * own channel, its own same-day quota pool), and so is its model list. The
 * roster is what the *activity* grants, not what the client's built-in catalog
 * lists: the built-in catalog is the candidate set, while the server admits
 * models per entitlement — measured 2026-09-30 on the live "ZCode Trust Build"
 * activity, which grants GLM-5.3-Flash only while the built-in catalog also
 * lists GLM-5.2 / GLM-5-Turbo (both answer \`400 code 3006 model not allowed\`).
 *
 * @module dsh-any-connect/zcode-plan-models
 */

import type { WorkBuddyModelInfo } from './catalog.js'

/** One entitlement as \`billing/balance\` declares it for an activity. */
export interface StartPlanEntitlement {
  entitlement_id?: string
  show_name?: string
  /** \`model:<id>\` entries name the models this entitlement admits. */
  capabilities?: readonly string[]
  meter?: string
  unit_type?: string
  grant_units?: number
}

/** One activity from \`billing/balance\`'s \`data.plans[]\`. */
export interface StartPlanActivity {
  plan_id?: string
  name?: string
  status?: string
  starts_at?: number
  ends_at?: number
  entitlements?: readonly StartPlanEntitlement[]
}

/**
 * ZCode Start Plan 专属通道的兜底模型名单：ZCode 客户端内置 provider 目录
 * `account:bigmodel-start-plan` 的 `builtinModelIds`（GLM-5.3-Flash /
 * GLM-5.2 / GLM-5-Turbo）。
 *
 * Start Plan 是与 Coding Plan 完全独立的产品：专属通道按 token 计量（当日
 * 有效的一次性余额），没有 Coding Plan 的 150% 折扣与夜间免费促销——徽标
 * 一概不带。
 *
 * **活动授权是名单的真源**：内置目录只是客户端给的候选，服务端按当前活动
 * 的 entitlements 放行——实测（2026-09-30，Trust Build）只授权 GLM-5.3-Flash，
 * 另外两个返回 `400 code 3006 model not allowed`。因此运行时名单由
 * {@link startPlanModelsFromEntitlements} 从 `billing/balance` 派生，本表只在
 * 拿不到授权信息时兜底。
 *
 * 每行的窗口/输出上限/档位取自客户端 `config/provider/zcode-builtin.json` 的
 * `modelConfigRules`（该文件是这些数值的权威来源）：GLM-5.3-Flash 与 GLM-5.2
 * 是 1M 窗口、128K 输出，GLM-5-Turbo 是 200K / 64K；服务端另外硬性限制
 * `max_tokens ≤ 131072`（实测 131073 → `400 code 1210`）。
 */
export const FALLBACK_ZCODE_START_PLAN_MODELS: readonly WorkBuddyModelInfo[] = [
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImages: true,
    reasoning: {
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
      canDisableThinking: false,
    },
    billing: { credits: 'x1.00', free: false },
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImages: false,
    reasoning: {
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['high', 'max'],
      defaultEffort: 'high',
      canDisableThinking: true,
    },
    billing: { credits: 'x1.00', free: false },
  },
  {
    id: 'glm-5-turbo',
    name: 'GLM-5-Turbo',
    contextWindow: 200000,
    maxTokens: 64000,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true },
    billing: { credits: 'x1.00', free: false },
  },
]

/**
 * Start Plan 的模型元数据表（按 id → 内置目录行），供授权派生时取窗口与档位。
 *
 * 未收录的 id 走保守默认（沿用客户端 `modelConfigRules` 里 `.*` 那条通用
 * 规则：200K 窗口、32K 输出、思考可关）——宁可报小不可虚报，也不因为新活动
 * 换了个模型名就让整组模型消失。
 */
export function startPlanModelInfo(
  id: string,
  known: readonly WorkBuddyModelInfo[] = FALLBACK_ZCODE_START_PLAN_MODELS,
): WorkBuddyModelInfo {
  const normalized = id.toLowerCase()
  const hit = known.find(model => model.id.toLowerCase() === normalized)
  if (hit !== undefined) return hit
  return {
    id: normalized,
    name: id,
    contextWindow: 200000,
    maxTokens: 32000,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true },
    billing: { credits: 'x1.00', free: false },
  }
}

/**
 * 活动是否仍然有效：`ends_at`（秒级 epoch）早于 `now` 即为过期。
 *
 * `ends_at` 缺失时按**有效**处理：名单宁可多给一次（上游会回明确的配额错误），
 * 也不能因为字段缺失就让用户丢掉整组模型。`now` 默认取真实时钟，测试可显式传入。
 *
 * 注意：**当日额度用尽 ≠ 活动过期**。这里只看活动本身的有效期与状态；"今天还没
 * 领取/还没发放" 是另一回事（表现为活动列表里根本没有条目），不在这里判定。
 */
export function isStartPlanActivityActive(
  activity: { status?: string; ends_at?: number },
  now: number = Date.now(),
): boolean {
  // status 缺失视为 active（上游省略该字段时不该当作失效），非 active 一律排除。
  if (activity.status !== undefined && activity.status !== 'active') return false
  const endsAt = activity.ends_at
  if (typeof endsAt !== 'number' || !Number.isFinite(endsAt)) return true
  return endsAt * 1000 >= now
}

/** One activity's entitlements, as {@link startPlanModelsFromEntitlements} takes them. */
export type StartPlanEntitlements = readonly {
  show_name?: string
  capabilities?: readonly string[]
  entitlement_id?: string
}[]

/**
 * 由当前活动的 entitlements 派生 Start Plan 的可用模型名单。
 *
 * 授权形状来自 `billing/balance` 的 `data.plans[].entitlements[]`：每个条目用
 * `capabilities: ["model:glm-5.3-flash"]` 声明它放行的模型，`show_name` 是展示
 * 名。
 *
 * 返回值有**两种含义**，调用方必须区分（这正是"过期活动仍显示模型"那个 bug 的
 * 根源）：
 * - **非空**：这是活动实际放行的名单，就是最终结果。
 * - **空**：`granted` 为 `true` 时是"已确认没有任何授权"（例：查到了活动列表，
 *   但没有一个活动在有效期内）——调用方应当据此**给出空名单**，不要回退兜底；
 *   `granted` 为 `false`（默认）时沿用历史语义"没有可用授权信息"，调用方应当
 *   回退 `fallback`，否则一次上游抖动就会让整个 Start Plan 分组从 DSH 里消失。
 *
 * 额度用尽与否不影响登记：余额是当日一次性池子（见卡片），额度耗尽应由上游
 * 给出明确的配额错误，而不是让模型在选择器里凭空消失。
 */
export function startPlanModelsFromEntitlements(
  entitlements: StartPlanEntitlements,
  fallback: readonly WorkBuddyModelInfo[] = FALLBACK_ZCODE_START_PLAN_MODELS,
  granted = false,
): readonly WorkBuddyModelInfo[] {
  const ids: string[] = []
  const push = (raw: string | undefined): void => {
    const id = raw?.trim().toLowerCase()
    if (id === undefined || id === '' || ids.includes(id)) return
    ids.push(id)
  }
  for (const entitlement of entitlements) {
    for (const capability of entitlement.capabilities ?? []) {
      if (capability.startsWith('model:')) push(capability.slice('model:'.length))
    }
  }
  if (ids.length === 0) {
    for (const entitlement of entitlements) push(entitlement.show_name)
  }
  // granted 表示"活动确实存在且已验证有效，只是没有任何可解析的模型"，此时空
  // 名单是**事实**而不是信息缺失——回退兜底会凭空造出用户没有被授权的模型。
  if (ids.length === 0) return granted ? [] : fallback
  return ids.map(id => startPlanModelInfo(id, fallback))
}


/** Re-exported so callers deriving a roster need only this module. */
export type { WorkBuddyModelInfo }
