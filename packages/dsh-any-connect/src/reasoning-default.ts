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
 * 只处理 OpenAI 形通道（workbuddy / workbuddy-ai）：它们的档位就是顶层
 * `reasoning_effort`。Anthropic 形通道（zcode）的思考开关是 `thinking` 预算对象，
 * 形似而义不同，不在本模块职责内。
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
