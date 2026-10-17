/**
 * upstream-zcode-body.ts — ZCode 请求体整形与兜底模型元数据（纯函数）。
 *
 * 2026-10-08 从 668 行的 upstream-zcode.ts 拆出。
 *
 * @module dsh-any-connect/upstream-zcode-body
 */

import type { WorkBuddyUpstreamModel } from './upstream-shared.js'

/**
 * Normalize an Anthropic messages body: force `stream: true`, ensure positive
 * `max_tokens` (required by Anthropic API), and convert OpenAI-shaped messages
 * if provided.
 */
export function prepareAnthropicBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true

  // max_tokens is mandatory on Anthropic /v1/messages
  if (typeof obj['max_tokens'] !== 'number' || obj['max_tokens'] <= 0) {
    if (typeof obj['max_completion_tokens'] === 'number' && obj['max_completion_tokens'] > 0) {
      obj['max_tokens'] = obj['max_completion_tokens']
    } else {
      obj['max_tokens'] = 8192
    }
  }
  delete obj['max_completion_tokens']

  // If OpenAI messages format with system/developer role, convert to top-level system
  if (Array.isArray(obj['messages'])) {
    const systemParts: string[] = []
    const filteredMessages: unknown[] = []
    for (const msg of obj['messages']) {
      if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) {
        const wrapped = msg as Record<string, unknown>
        if (wrapped['role'] === 'system' || wrapped['role'] === 'developer') {
          if (typeof wrapped['content'] === 'string') {
            systemParts.push(wrapped['content'])
          }
          continue
        }
      }
      filteredMessages.push(msg)
    }
    if (systemParts.length > 0) {
      const existing = obj['system']
      if (existing === undefined) {
        obj['system'] = systemParts.join('\n\n')
        obj['messages'] = filteredMessages
      } else if (typeof existing === 'string') {
        // 顶层 system 已有字符串:追加合并,不能整段丢弃——否则 system/
        // developer 消息留在 messages 里,Anthropic 端点直接拒绝请求。
        obj['system'] = existing === '' ? systemParts.join('\n\n') : `${existing}\n\n${systemParts.join('\n\n')}`
        obj['messages'] = filteredMessages
      } else if (Array.isArray(existing)) {
        // Anthropic blocks 形态的顶层 system(合法):文本块追加在数组尾,
        // 整体覆盖会静默丢失原 system 内容。
        obj['system'] = [...existing, ...systemParts.map(text => ({ type: 'text', text }))]
        obj['messages'] = filteredMessages
      }
      // 其余畸形形态保持原样(连同 system 消息),交给上游校验给出明确错误。
    }
  }

  // If OpenAI tools format with type 'function', convert to Anthropic input_schema
  if (Array.isArray(obj['tools']) && obj['tools'].length > 0) {
    obj['tools'] = obj['tools'].map(t => {
      if (typeof t === 'object' && t !== null && !Array.isArray(t)) {
        const wt = t as Record<string, unknown>
        if (wt['type'] === 'function' && typeof wt['function'] === 'object' && wt['function'] !== null) {
          const fn = wt['function'] as Record<string, unknown>
          return {
            name: typeof fn['name'] === 'string' ? fn['name'] : '',
            description: typeof fn['description'] === 'string' ? fn['description'] : '',
            input_schema: typeof fn['parameters'] === 'object' && fn['parameters'] !== null ? fn['parameters'] : { type: 'object', properties: {} },
          }
        }
      }
      return t
    })
  }

  return JSON.stringify(obj)
}

/**
 * 上游新出现、本地目录尚未收录的模型 id 的保守默认行。
 *
 * 与 Start Plan 的 `startPlanModelInfo` 同口径：宁可报小不可虚报——200K 窗口、
 * 32K 输出、不支持图像、思考可关、x1.00 基准费率、不带任何促销徽标。参数报小
 * 顶多少用一点上下文，报大了会让上游直接拒绝请求；费率同理，凭空打折或加价都
 * 是错的。真实值等官方目录收录后随发版修正。
 *
 * 名字保留上游原样（只做 id 小写归一）——展示名由上游 id 推导比编造一个更好。
 */
export function defaultZCodeModelInfo(id: string): WorkBuddyUpstreamModel {
  return {
    id: id.toLowerCase(),
    name: id,
    contextWindow: 200000,
    maxTokens: 32000,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true },
    billing: { credits: 'x1.00', free: false },
  }
}

/** Options for ZCodeUpstreamClient. */
