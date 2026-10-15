/**
 * upstream-opencode.ts — OpenCode 上游客户端（官方免费模型通道）。
 *
 * 封装向 https://opencode.ai/inference/v1/chat/completions 发起的聊天请求，
 * 携带经过逆向取证验证的过闸标头与工具守卫（自动注入 read 工具以解除免费通道限制）。
 *
 * @module dsh-any-connect/upstream-opencode
 */

import { randomBytes } from 'node:crypto'
import type { WorkBuddyCredential } from './auth-types.js'
import type { ProbeAttempt } from './probe.js'
import {
  settleChatFetch,
  classifyUpstreamError,
  type WorkBuddyUpstreamModel,
  type WorkBuddyCredits,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyChatResult,
} from './upstream-shared.js'

export const OPENCODE_BASE_URL = 'https://opencode.ai'
export const OPENCODE_CHAT_COMPLETIONS_URL = 'https://opencode.ai/inference/v1/chat/completions'
export const OPENCODE_CLI_USER_AGENT = 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
export const OPENCODE_DEFAULT_PROJECT_ID = '5da9b72c6f3d58f67b560a1dd82e3c067c3fbd18'

/**
 * OpenCode 官方 ID 生成算法（逆向取证事实）：
 * - descending=true (SessionID): 前 12 字符为 ~BigInt(Date.now()*4096+cA) 的 16 进制按位反转补码
 * - descending=false (MessageID): 前 12 字符为 BigInt(Date.now()*4096+cA) 的 16 进制升序时间戳
 * - 后 14 字符为 62 进制字母数字随机串
 */
let lastTimestamp = 0
let sequenceCounter = 0
export function generateOpenCodeId(descending: boolean, now: number = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now
    sequenceCounter = 0
  }
  sequenceCounter++
  const num = BigInt(now) * 0x1000n + BigInt(sequenceCounter)
  const U = descending ? ~num : num
  const hexPrefix = Array.from({ length: 6 }, (_, W) =>
    Number((U >> BigInt(40 - 8 * W)) & 0xffn).toString(16).padStart(2, '0')
  ).join('')
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  const randomSuffix = Array.from(randomBytes(14), (byte) => chars[byte % 62]).join('')
  return hexPrefix + randomSuffix
}

/** 网关免费通道强制要求的只读文件工具定义 */
export const OPENCODE_READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
      },
      required: ['filePath'],
    },
  },
} as const

/** 检查 tools 列表中是否已包含名为 read 的工具 */
function hasReadTool(tools: unknown[]): boolean {
  for (const t of tools) {
    if (typeof t !== 'object' || t === null) continue
    const tool = t as { name?: unknown; function?: { name?: unknown } }
    if (tool.name === 'read' || tool.function?.name === 'read') return true
  }
  return false
}

/**
 * 为 OpenCode 免费通道整形请求体：
 * 1. 确保 stream: true 与 stream_options.include_usage: true
 * 2. 注入 read tool 与 tool_choice: auto 守卫（解除 "free tier can only be used from within OpenCode" 网关拦截）
 */
export function prepareOpenCodeChatBody(bodyJson: string): string {
  try {
    const parsed = JSON.parse(bodyJson) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return bodyJson

    // 1. 确保为流式输出
    parsed['stream'] = true
    if (!parsed['stream_options']) {
      parsed['stream_options'] = { include_usage: true }
    }

    // 2. 注入 read tool 守卫与 tool_choice: auto
    const existingTools = parsed['tools']
    if (Array.isArray(existingTools)) {
      if (!hasReadTool(existingTools)) {
        parsed['tools'] = [...existingTools, OPENCODE_READ_TOOL]
      }
    } else {
      parsed['tools'] = [OPENCODE_READ_TOOL]
    }
    if (!parsed['tool_choice']) {
      parsed['tool_choice'] = 'auto'
    }

    return JSON.stringify(parsed)
  } catch {
    return bodyJson
  }
}

export const OPENCODE_FALLBACK_CREDITS: WorkBuddyCredits = {
  total: 999999,
  accounts: [
    {
      packageName: 'OpenCode Free Tier',
      remain: 999999,
      size: 999999,
      planName: 'Free Models',
    },
  ],
}

export interface OpenCodeUpstreamClientOptions {
  models?: readonly WorkBuddyUpstreamModel[]
  projectId?: string
}

/**
 * OpenCode upstream client: manages streaming chat completions with free tier gateway bypass.
 */
export class OpenCodeUpstreamClient {
  private readonly models: readonly WorkBuddyUpstreamModel[]
  private readonly projectId: string

  constructor(options: OpenCodeUpstreamClientOptions = {}) {
    this.models = options.models ?? []
    this.projectId = options.projectId ?? OPENCODE_DEFAULT_PROJECT_ID
  }

  /** POST the chat completions endpoint with gateway bypass headers and tool guard */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    const sessionId = `ses_${generateOpenCodeId(true)}`
    const requestId = `msg_${generateOpenCodeId(false)}`
    const auth = credential.accessToken && credential.accessToken.trim() !== ''
      ? `Bearer ${credential.accessToken.trim()}`
      : 'Bearer public'

    const preparedBody = prepareOpenCodeChatBody(bodyJson)

    const settled = await settleChatFetch(signal, async (fetchSignal) => {
      return fetch(OPENCODE_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, */*',
          'Authorization': auth,
          'user-agent': OPENCODE_CLI_USER_AGENT,
          'x-opencode-client': 'cli',
          'x-opencode-project': this.projectId,
          'x-opencode-request': requestId,
          'x-opencode-session': sessionId,
          'x-opencode-session-id': sessionId,
          'x-session-affinity': sessionId,
          'x-session-id': sessionId,
          'connection': 'keep-alive',
        },
        body: preparedBody,
        signal: fetchSignal,
      })
    })

    if (settled.settled) return settled.result
    const { response, text } = settled
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  async fetchModels(_credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    return this.models
  }

  async fetchCredits(_credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    return OPENCODE_FALLBACK_CREDITS
  }

  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    return { accessToken: credential.accessToken }
  }

  async probeEffort(
    _credential: WorkBuddyCredential,
    _model: string,
    _effort: string | undefined,
    _signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    return { status: 200, streamed: true }
  }
}
