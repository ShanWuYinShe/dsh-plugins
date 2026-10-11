/**
 * 「默认」思考等级真正下发给上游的档位。
 *
 * 背景（2026-10-11 实测）：选择器里的「默认（provider default）」在链路上被
 * 消解为「不发 `reasoning_effort`」，由上游用自己的默认。对 `onlyReasoning: true`
 * 的模型——它们只能在思考态工作，没有「不思考 / default」这一状态——实测表现
 * 为响应里没有任何思考内容（deepseek-v4.1-flash / glm-5.3 / glm-5.3-flash 三行
 * 同为 0 字符，而显式 low/medium/high/max 都有思考内容），既不可预测，也不符合
 * 「思考模型就该思考」的预期。
 *
 * 规则（用户指定，2026-10-11）：模型不支持 default → 下发 `high`；没有 `high`
 * 就用可用档位里的**最高**一档；一个可用档位都没有时才不发（那时上游默认是唯一
 * 语义）。可用档位与 `reasoningFields` 同源（声明集合优先，旧形态行退化为其
 * 声明的 defaultEffort），所以这里选出的档位一定是选择器会展示的档位之一。
 *
 * 两个通道都按同一规则补档，只是表达不同：OpenAI 形通道（workbuddy /
 * workbuddy-ai）补顶层 `reasoning_effort`；Anthropic 形通道（zcode）补 `thinking`
 * 预算对象，且与 pi-ai 显式选该档位时同形（见 `applyDefaultThinking`）。
 *
 * @module dsh-any-connect/reasoning-default
 */

import type { WorkBuddyModelInfo } from './catalog.js'

/** 档位升级顺序（用于「最高一档」）。与上游 `WorkBuddyEffort` 取值域一致。 */
const EFFORT_ESCALATION = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 一条「默认」请求应下发的具体档位，或 `undefined` 表示确实不该发。
 *
 * `undefined` 的两种情况都是「发字段反而错」：模型不是推理模型，或它有真正的
 * 非思考状态（`onlyReasoning !== true`，此时不发字段就是它自己的默认）。
 */
export function defaultFallbackEffort(info: WorkBuddyModelInfo | undefined): string | undefined {
  const reasoning = info?.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return undefined
  // 只有「没有非思考状态」的模型才需要兜底。
  if (reasoning.onlyReasoning !== true) return undefined
  const declared = reasoning.supportedEfforts !== undefined && reasoning.supportedEfforts.length > 0
    ? reasoning.supportedEfforts
    : undefined
  const available: readonly string[] = declared ?? [reasoning.defaultEffort ?? 'high']
  if (available.includes('high')) return 'high'
  for (let index = EFFORT_ESCALATION.length - 1; index >= 0; index -= 1) {
    const level = EFFORT_ESCALATION[index] as string
    if (available.includes(level)) return level
  }
  return undefined
}

/**
 * 就一条准备转发给上游的 OpenAI 形请求体，补上「默认档」的回落档位。
 *
 * 只在请求**本来就没带** `reasoning_effort` 时动手：显式档位（用户真选了
 * 低/中/高/最高）原样保留。返回原字符串（而不是重新序列化）的情况有三种——
 * 不是 JSON、不是对象、没有可解析的 model——都是「不该由这里改写」的输入。
 */
export function applyDefaultEffort(
  bodyJson: string,
  lookup: (modelId: string) => WorkBuddyModelInfo | undefined,
): string {
  let body: unknown
  try {
    body = JSON.parse(bodyJson)
  } catch {
    // 不是 JSON：上游本来就会拒，改写没有意义。
    return bodyJson
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bodyJson
  const record = body as Record<string, unknown>
  if (record['reasoning_effort'] !== undefined) return bodyJson
  const modelId = typeof record['model'] === 'string' ? record['model'] : undefined
  if (modelId === undefined) return bodyJson
  const effort = defaultFallbackEffort(lookup(modelId))
  if (effort === undefined) return bodyJson
  record['reasoning_effort'] = effort
  return JSON.stringify(record)
}

/**
 * pi-ai 的档位预算表与保护常量，抄自
 * `@earendil-works/pi-ai/dist/api/simple-options.js`（2026-10-11 的实测版本）。
 *
 * 抄录而非引用：pi-ai 是宿主依赖、不是本插件的直接依赖，且它没有导出这张表。
 * 数字漂移不会让请求失败（预算只是个上限），但会让「默认」与「显式选高」在字节
 * 上不再等价——升级 pi-ai 后应重新核对这里。
 */
const PI_THINKING_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const

/** 与 pi-ai `MIN_ANSWER_TOKENS` 一致：共享响应上限里至少留出的答案余量。 */
const MIN_ANSWER_TOKENS = 1024

/** 与 pi-ai `clampReasoning` 同义：`xhigh`/`max` 的预算等同 `high`。 */
function budgetForLevel(level: string): number {
  const key = level === 'xhigh' || level === 'max' ? 'high' : level
  return PI_THINKING_BUDGETS[key as keyof typeof PI_THINKING_BUDGETS] ?? PI_THINKING_BUDGETS.high
}

/**
 * 就一条准备转发的 Anthropic 形请求体，把「默认档」补成具体档位。
 *
 * 形状与算式都对齐 pi-ai 显式选该档位时的行为：
 * `thinking = { type: 'enabled', budget_tokens, display: 'summarized' }`，并按
 * `adjustMaxTokensForThinking` 抬高 `max_tokens` 以容纳预算（上限是该模型的
 * `maxTokens`），最后再按答案余量夹一次预算。
 *
 * 触发条件与 OpenAI 通道完全一致（同一个 `defaultFallbackEffort`）：只有
 * `onlyReasoning: true` 的模型才补，且请求必须**完全没有** `thinking` 字段——
 * 显式开/关（含用户选档位）一律不动。
 *
 * 实测（2026-10-11，ZCode / glm-5.3）：不发 `thinking` 时上游仍会思考（94 个
 * `thinking_delta`），所以这一步买的不是「能不能思考」，而是**档位确定性**——
 * 「默认」与「显式选该档」在线上同形。
 *
 * `max_tokens` 与目录都推不出上限时宁可不补：预算大于 `max_tokens` 会被
 * Anthropic 协议直接拒。
 */
export function applyDefaultThinking(
  bodyJson: string,
  lookup: (modelId: string) => WorkBuddyModelInfo | undefined,
): string {
  let body: unknown
  try {
    body = JSON.parse(bodyJson)
  } catch {
    return bodyJson
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bodyJson
  const record = body as Record<string, unknown>
  if (record['thinking'] !== undefined) return bodyJson
  const modelId = typeof record['model'] === 'string' ? record['model'] : undefined
  if (modelId === undefined) return bodyJson
  const info = lookup(modelId)
  const level = defaultFallbackEffort(info)
  if (level === undefined) return bodyJson
  const modelMax = typeof info?.maxTokens === 'number' && info.maxTokens > 0 ? info.maxTokens : undefined
  const bodyCapRaw = record['max_tokens']
  const bodyCap = typeof bodyCapRaw === 'number' && bodyCapRaw > 0 ? bodyCapRaw : undefined
  const baseMax = bodyCap ?? modelMax
  if (baseMax === undefined) return bodyJson
  const budget = budgetForLevel(level)
  const maxTokens = Math.min(baseMax + budget, modelMax ?? baseMax + budget)
  let adjusted = budget
  if (maxTokens <= adjusted) adjusted = Math.min(adjusted, Math.max(0, maxTokens - MIN_ANSWER_TOKENS))
  record['max_tokens'] = maxTokens
  record['thinking'] = {
    type: 'enabled',
    budget_tokens: Math.min(adjusted, Math.max(0, maxTokens - MIN_ANSWER_TOKENS)),
    display: 'summarized',
  }
  return JSON.stringify(record)
}
