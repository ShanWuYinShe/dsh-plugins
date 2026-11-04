/**
 * upstream-opencode.ts — OpenCode 上游客户端（官方免费模型通道）。
 *
 * 封装向 https://opencode.ai/inference/v1/chat/completions 发起的聊天请求，
 * 携带经过逆向取证验证的过闸标头与工具守卫（自动注入 read 工具以解除免费通道限制）。
 *
 * @module dsh-any-connect/upstream-opencode
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { WorkBuddyCredential } from './auth-types.js'
import type { ProbeAttempt } from './probe.js'
import { deadlineSignal } from './timeout.js'
import {
  settleChatFetch,
  classifyUpstreamError,
  JSON_TIMEOUT_MS,
  type ModelWireProtocol,
  type WorkBuddyUpstreamModel,
  type WorkBuddyCredits,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyChatResult,
} from './upstream-shared.js'

export const OPENCODE_CHAT_COMPLETIONS_URL = 'https://opencode.ai/inference/v1/chat/completions'
export const OPENCODE_RESPONSES_URL = 'https://opencode.ai/inference/openai/v1/responses'
export const OPENCODE_ANTHROPIC_MESSAGES_URL = 'https://opencode.ai/inference/anthropic/v1/messages'
export const OPENCODE_MODELS_URL = 'https://opencode.ai/inference/v1/models'
export const OPENCODE_CLI_USER_AGENT = 'opencode/latest/2.0.11/cli'
const OPENCODE_DEFAULT_PROJECT_ID = '5da9b72c6f3d58f67b560a1dd82e3c067c3fbd18'

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

/** 网关免费通道强制要求的只读文件工具定义（对齐官方 CLI 内置工具 schema） */
export const OPENCODE_READ_TOOL = {
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['path'],
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

/** 网关免费通道强制要求的 Anthropic 格式只读文件工具定义（对齐官方 CLI 内置工具 schema） */
export const OPENCODE_ANTHROPIC_READ_TOOL = {
  name: 'read',
  description: 'Read a file',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['path'],
  },
} as const

/** 检查 Anthropic tools 列表中是否已包含名为 read 的工具 */
function hasAnthropicReadTool(tools: unknown[]): boolean {
  for (const t of tools) {
    if (typeof t !== 'object' || t === null) continue
    const tool = t as { name?: unknown }
    if (tool.name === 'read') return true
  }
  return false
}

/**
 * 将输入请求整形为 OpenCode Anthropic Messages 规范请求体：
 * 1. 提取 system/developer 消息至顶层 system 字段
 * 2. 映射 messages 为 Anthropic user/assistant 规范
 * 3. 确保 max_tokens 与 stream: true
 * 4. 注入 Anthropic 格式的 read 工具守卫解除网关限制
 */
export function prepareOpenCodeAnthropicBody(bodyJson: string): string {
  try {
    const parsed = JSON.parse(bodyJson) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null) return bodyJson

    let system = typeof parsed['system'] === 'string' ? parsed['system'].trim() : ''
    const rawMessages = Array.isArray(parsed['messages']) ? parsed['messages'] : []
    const anthropicMessages: Array<{ role: string; content: unknown }> = []

    for (const msg of rawMessages) {
      if (typeof msg !== 'object' || msg === null) continue
      const m = msg as { role?: unknown; content?: unknown }
      const role = typeof m.role === 'string' ? m.role.trim().toLowerCase() : ''
      if (role === 'system' || role === 'developer') {
        const text = typeof m.content === 'string' ? m.content.trim() : ''
        if (text !== '') {
          system = system ? `${system}\n\n${text}` : text
        }
      } else if (role === 'user' || role === 'assistant') {
        anthropicMessages.push({
          role,
          content: m.content ?? '',
        })
      }
    }

    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: 'user', content: ' ' })
    }

    const maxTokens = typeof parsed['max_tokens'] === 'number' && parsed['max_tokens'] > 0
      ? parsed['max_tokens']
      : 4096

    const result: Record<string, unknown> = {
      model: parsed['model'],
      messages: anthropicMessages,
      max_tokens: maxTokens,
      stream: true,
    }

    if (system !== '') {
      result['system'] = system
    }

    if (typeof parsed['temperature'] === 'number') {
      result['temperature'] = parsed['temperature']
    }

    const existingTools = parsed['tools']
    const normalizedTools: unknown[] = []
    if (Array.isArray(existingTools)) {
      for (const t of existingTools) {
        if (typeof t !== 'object' || t === null) continue
        const item = t as Record<string, unknown>
        if (item['type'] === 'function' && typeof item['function'] === 'object' && item['function'] !== null) {
          const fn = item['function'] as Record<string, unknown>
          normalizedTools.push({
            name: fn['name'],
            description: fn['description'],
            input_schema: fn['parameters'] ?? { type: 'object' },
          })
        } else {
          normalizedTools.push(t)
        }
      }
    }
    if (!hasAnthropicReadTool(normalizedTools)) {
      normalizedTools.push(OPENCODE_ANTHROPIC_READ_TOOL)
    }
    result['tools'] = normalizedTools

    return JSON.stringify(result)
  } catch {
    return bodyJson
  }
}

/**
 * 将 Anthropic Messages API 的 SSE 事件流实时转码为标准 OpenAI Chat Completions SSE 流。
 * 兼容 DSH 宿主前端与消费端（支持实时输出 reasoning_content 思考过程与 content 正文）。
 */
export function transformAnthropicStreamToChatCompletions(
  inputStream: ReadableStream<Uint8Array>,
  modelName: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let responseId = `chatcmpl_ant_${Date.now()}`
  let sentStart = false
  let sentDone = false

  function emitChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    const payload = {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  function processLine(line: string): string {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return ''
    const dataStr = trimmed.slice(5).trim()
    if (dataStr === '[DONE]') {
      if (!sentDone) {
        sentDone = true
        return 'data: [DONE]\n\n'
      }
      return ''
    }

    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>
      if (parsed['object'] === 'chat.completion.chunk' || Array.isArray(parsed['choices'])) {
        return `${trimmed}\n\n`
      }

      const eventType = typeof parsed['type'] === 'string' ? parsed['type'] : ''
      let out = ''

      if (eventType === 'message_start') {
        const msg = parsed['message'] as Record<string, unknown> | undefined
        if (typeof msg?.['id'] === 'string' && msg['id'] !== '') {
          responseId = msg['id']
        }
        if (!sentStart) {
          sentStart = true
          out += emitChunk({ role: 'assistant' })
        }
      } else if (eventType === 'content_block_start') {
        if (!sentStart) {
          sentStart = true
          out += emitChunk({ role: 'assistant' })
        }
      } else if (eventType === 'content_block_delta') {
        const deltaObj = parsed['delta'] as Record<string, unknown> | undefined
        if (deltaObj && typeof deltaObj === 'object') {
          if (deltaObj['type'] === 'thinking_delta' || typeof deltaObj['thinking'] === 'string') {
            const thinking = typeof deltaObj['thinking'] === 'string' ? deltaObj['thinking'] : ''
            if (thinking !== '') out += emitChunk({ reasoning_content: thinking })
          } else if (deltaObj['type'] === 'text_delta' || typeof deltaObj['text'] === 'string') {
            const text = typeof deltaObj['text'] === 'string' ? deltaObj['text'] : ''
            if (text !== '') out += emitChunk({ content: text })
          }
        }
      } else if (eventType === 'message_delta' || eventType === 'message_stop') {
        if (!sentDone) {
          out += emitChunk({}, 'stop')
          out += 'data: [DONE]\n\n'
          sentDone = true
        }
      }
      return out
    } catch {
      return ''
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = inputStream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const emitted = processLine(line)
            if (emitted !== '') controller.enqueue(encoder.encode(emitted))
          }
        }
        if (buffer.trim() !== '') {
          const emitted = processLine(buffer)
          if (emitted !== '') controller.enqueue(encoder.encode(emitted))
        }
        if (!sentDone) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          sentDone = true
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
    cancel(reason) {
      return inputStream.cancel(reason)
    },
  })
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

export interface OpenCodeModelSpec {
  id?: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
    output?: number
  }
  provider?: {
    npm?: string
    api?: string
  }
  wireProtocol?: ModelWireProtocol
}

/**
 * 根据 Provider 声明的 npm 包名决议底层推理协议：
 * - '@ai-sdk/openai' -> 'responses'
 * - '@ai-sdk/anthropic' -> 'anthropic-messages'
 * - '@ai-sdk/openai-compatible' (及默认) -> 'chat-completions'
 */
export function resolveProtocolFromNpm(npm?: string): ModelWireProtocol {
  if (!npm) return 'chat-completions'
  const trimmed = npm.trim()
  if (trimmed === '@ai-sdk/openai') return 'responses'
  if (trimmed === '@ai-sdk/anthropic') return 'anthropic-messages'
  return 'chat-completions'
}

/** 静态内置模型的协议映射（对齐官方 Console 文档 https://opencode.ai/v2/docs/console/models/） */
const FALLBACK_PROTOCOL_MAP: Readonly<Record<string, ModelWireProtocol>> = {
  'muse-spark-1.2-contributor-free': 'responses',
  'muse-spark-1.3-contributor-free': 'responses',
  'qwen3.6-plus-free': 'anthropic-messages',
  'minimax-m2.1-free': 'chat-completions',
}

/**
 * 对所有模型严格使用 provider 中对应模型真实支持的协议：
 * 1. 优先查 models 中该模型已声明的 wireProtocol；
 * 2. 查 specs 中该模型官方声明的 wireProtocol 或 provider.npm；
 * 3. 查 fallback 静态表中的 wireProtocol；
 * 4. 通用模型家族规则兜底。
 */
export function resolveOpenCodeModelProtocol(
  modelId: string,
  specs?: Map<string, OpenCodeModelSpec>,
  models?: readonly WorkBuddyUpstreamModel[],
): ModelWireProtocol {
  const normalized = modelId.trim().toLowerCase()
  if (normalized === '') return 'chat-completions'

  // 1. 优先查 models 列表（如果传入了当前已合并或已注册的模型元数据）
  if (models && models.length > 0) {
    const found = models.find(m => m.id.toLowerCase() === normalized)
    if (found?.wireProtocol) {
      return found.wireProtocol
    }
  }

  // 2. 查 specs（来自官方 models.json 本地缓存真源）
  const spec = specs?.get(normalized) ?? specs?.get(modelId)
  if (spec?.wireProtocol) {
    return spec.wireProtocol
  }
  if (spec?.provider?.npm) {
    return resolveProtocolFromNpm(spec.provider.npm)
  }

  // 3. 查内置静态模型的 wireProtocol 兜底
  const staticProtocol = FALLBACK_PROTOCOL_MAP[normalized]
  if (staticProtocol) {
    return staticProtocol
  }

  // 4. 通用模型家族特征规则兜底（对齐官方文档 https://opencode.ai/v2/docs/console/models/）
  if (
    normalized.startsWith('muse-') ||
    normalized.includes('muse-spark') ||
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1-') ||
    normalized.startsWith('o3-') ||
    normalized.startsWith('grok-')
  ) {
    return 'responses'
  }
  if (
    normalized.startsWith('claude-') ||
    (normalized.startsWith('qwen') && !normalized.includes('max'))
  ) {
    return 'anthropic-messages'
  }

  return 'chat-completions'
}

/**
 * 根据模型真实协议决议目标上游推理 URL：
 * - 'responses' -> /inference/v1/responses
 * - 'anthropic-messages' -> /inference/anthropic/v1/messages
 * - 'chat-completions' -> /inference/v1/chat/completions
 */
export function resolveOpenCodeEndpoint(
  modelId: string,
  specs?: Map<string, OpenCodeModelSpec>,
  models?: readonly WorkBuddyUpstreamModel[],
): string {
  const protocol = resolveOpenCodeModelProtocol(modelId, specs, models)
  switch (protocol) {
    case 'responses':
      return OPENCODE_RESPONSES_URL
    case 'anthropic-messages':
      return OPENCODE_ANTHROPIC_MESSAGES_URL
    case 'chat-completions':
    default:
      return OPENCODE_CHAT_COMPLETIONS_URL
  }
}

/**
 * 将 OpenAI Responses API 的 SSE 事件流实时转码为标准 OpenAI Chat Completions SSE 流。
 * 兼容 DSH 宿主前端与消费端（支持实时输出 reasoning_content 思考过程与 content 正文）。
 */
export function transformResponsesStreamToChatCompletions(
  inputStream: ReadableStream<Uint8Array>,
  modelName: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let responseId = `chatcmpl_muse_${Date.now()}`
  let sentStart = false
  let sentDone = false

  function emitChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    const payload = {
      id: responseId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    }
    return `data: ${JSON.stringify(payload)}\n\n`
  }

  function processLine(line: string): string {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      return ''
    }
    const dataStr = trimmed.slice(5).trim()
    if (dataStr === '[DONE]') {
      if (!sentDone) {
        sentDone = true
        return 'data: [DONE]\n\n'
      }
      return ''
    }

    try {
      const parsed = JSON.parse(dataStr) as Record<string, unknown>
      // 若上游已是标准 chat.completion.chunk 格式，直接透传原行
      if (parsed['object'] === 'chat.completion.chunk' || Array.isArray(parsed['choices'])) {
        return `${trimmed}\n\n`
      }

      const eventType = typeof parsed['type'] === 'string' ? parsed['type'] : ''
      let out = ''

      if (eventType === 'response.created') {
        const resp = parsed['response'] as Record<string, unknown> | undefined
        if (typeof resp?.['id'] === 'string' && resp['id'] !== '') {
          responseId = resp['id']
        }
        if (!sentStart) {
          sentStart = true
          out += emitChunk({ role: 'assistant' })
        }
      } else if (eventType === 'response.output_item.added') {
        if (!sentStart) {
          sentStart = true
          out += emitChunk({ role: 'assistant' })
        }
      } else if (eventType === 'response.reasoning_text.delta') {
        const delta = typeof parsed['delta'] === 'string' ? parsed['delta'] : ''
        if (delta !== '') {
          out += emitChunk({ reasoning_content: delta })
        }
      } else if (eventType === 'response.output_text.delta' || eventType === 'response.text.delta') {
        const delta = typeof parsed['delta'] === 'string' ? parsed['delta'] : ''
        if (delta !== '') {
          out += emitChunk({ content: delta })
        }
      } else if (eventType === 'response.output_item.done' || eventType === 'response.completed') {
        if (!sentDone) {
          out += emitChunk({}, 'stop')
          out += 'data: [DONE]\n\n'
          sentDone = true
        }
      }
      return out
    } catch {
      return ''
    }
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = inputStream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const emitted = processLine(line)
            if (emitted !== '') {
              controller.enqueue(encoder.encode(emitted))
            }
          }
        }
        if (buffer.trim() !== '') {
          const emitted = processLine(buffer)
          if (emitted !== '') {
            controller.enqueue(encoder.encode(emitted))
          }
        }
        if (!sentDone) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          sentDone = true
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      } finally {
        reader.releaseLock()
      }
    },
    cancel(reason) {
      return inputStream.cancel(reason)
    },
  })
}

export interface OpenCodeModelsApiResponse {
  object?: string
  data?: Array<{
    id?: string
    object?: string
    created?: number
    owned_by?: string
  }>
}

/**
 * 检查模型 ID 是否属于 OpenCode 免费模型通道。
 * 实测事实：OpenCode 网关通过 `-free` 后缀或专用免费别名（如 `big-pickle`）标识免费模型。
 */
export function isOpenCodeFreeModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase()
  if (normalized === '') return false
  return normalized === 'big-pickle' || normalized.includes('-free')
}

/**
 * 将模型 ID 格式化为美观的展示名称。
 */
export function formatOpenCodeModelName(id: string): string {
  const overrides: Record<string, string> = {
    'big-pickle': 'Big Pickle',
    'cat-jam-free': 'Cat Jam Free',
    'mimo-v2.6-flash-free': 'MiMo-V2.6-Flash Free',
    'muse-spark-1.2-contributor-free': 'Muse Spark 1.2 Free',
    'muse-spark-1.3-contributor-free': 'Muse Spark 1.3 Free',
    'qwen3.6-plus-free': 'Qwen3.6 Plus Free',
    'minimax-m2.1-free': 'MiniMax-M2.1 Free',
    'minimax-m2.5-free': 'MiniMax-M2.5 Free',
    'minimax-m3-free': 'MiniMax-M3 Free',
    'nemotron-3.5-super-vl-free': 'Nemotron 3.5 Super VL Free',
    'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning Free',
    'jev-1.13-free': 'Jev 1.13 Free',
    'step-5-preview-free': 'Step 5 Preview Free',
    'longcat-2.5-preview-free': 'LongCat 2.5 Preview Free',
    'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash Free',
    'space-bunny-free': 'Space Bunny Free',
    'nemotron-3-ultra-free': 'Nemotron 3 Ultra Free',
  }
  if (overrides[id]) return overrides[id]

  return id
    .split('-')
    .map(part => {
      const lower = part.toLowerCase()
      if (lower === 'vl') return 'VL'
      if (lower === 'free') return 'Free'
      return part.charAt(0).toUpperCase() + part.slice(1)
    })
    .join(' ')
}

/**
 * OpenCode 官方元数据本地缓存路径（由 OpenCode CLI 同步落盘）。
 */
function defaultOpenCodeCachePath(): string {
  if (process.env.OPENCODE_MODELS_CACHE) {
    return process.env.OPENCODE_MODELS_CACHE
  }
  const home = homedir()
  const xdgCache = process.env.XDG_CACHE_HOME || join(home, '.cache')
  return join(xdgCache, 'opencode', 'models.json')
}

/**
 * 读取本地 OpenCode 官方模型元数据规范（含真实 contextWindow, maxTokens, attachment, wireProtocol）。
 */
function readLocalOpenCodeSpecs(cachePath: string = defaultOpenCodeCachePath()): Map<string, OpenCodeModelSpec> | undefined {
  try {
    if (!existsSync(cachePath)) return undefined
    const text = readFileSync(cachePath, 'utf8')
    const json = JSON.parse(text) as {
      opencode?: {
        npm?: string
        models?: Record<string, OpenCodeModelSpec>
      }
    }
    const opencode = json?.opencode
    if (!opencode?.models || typeof opencode.models !== 'object') return undefined
    const defaultNpm = opencode.npm ?? '@ai-sdk/openai-compatible'
    const result = new Map<string, OpenCodeModelSpec>()
    for (const [id, spec] of Object.entries(opencode.models)) {
      const effectiveNpm = spec.provider?.npm ?? defaultNpm
      result.set(id, {
        ...spec,
        wireProtocol: resolveProtocolFromNpm(effectiveNpm),
      })
    }
    return result
  } catch {
    return undefined
  }
}

/**
 * 合并上游在线免费模型名单与模型规格元数据：
 * - 上游 API 给出实时在线的全部模型 ID（白名单/在线状态真源）；
 * - 规格元数据依次从本地官方 cache、内置 fallback 表中解析精确 contextWindow、maxTokens、图片能力与推理能力；
 * - 若上游返回空列表或全非免费模型，安全回退到 fallbackModels。
 */
export function mergeOpenCodeCatalogue(
  fallbackModels: readonly WorkBuddyUpstreamModel[],
  upstreamIds: readonly string[],
  specs?: Map<string, OpenCodeModelSpec>,
): readonly WorkBuddyUpstreamModel[] {
  const fallbackById = new Map(fallbackModels.map(m => [m.id, m]))
  const freeIds = upstreamIds.filter(isOpenCodeFreeModelId)
  if (freeIds.length === 0) {
    return fallbackModels
  }

  return freeIds.map(id => {
    const fallback = fallbackById.get(id)
    const spec = specs?.get(id)

    const name = spec?.name?.trim() || fallback?.name || formatOpenCodeModelName(id)

    // 上下文窗口按最高准确度来源决议：官方 spec -> fallback 表 -> 保守默认
    const contextWindow = (typeof spec?.limit?.context === 'number' && spec.limit.context > 0)
      ? spec.limit.context
      : (fallback?.contextWindow ?? 200_000)

    // 输出上限决议：官方 spec -> fallback 表 -> 保守默认
    const maxTokens = (typeof spec?.limit?.output === 'number' && spec.limit.output > 0)
      ? spec.limit.output
      : (fallback?.maxTokens ?? 32_000)

    // 多模态图像支持决议
    const supportsImages = spec !== undefined
      ? (spec.attachment === true || (Array.isArray(spec.modalities?.input) && spec.modalities.input.includes('image')))
      : (fallback?.supportsImages ?? (id.includes('vl') || id.includes('vision')))

    // 思考能力决议
    const reasoning = fallback?.reasoning ?? {
      supports: spec?.reasoning !== false,
      onlyReasoning: false,
      canDisableThinking: true,
    }

    const billing = fallback?.billing ?? {
      credits: 'x0.00',
      badges: ['免费', '推理'],
      free: true,
    }

    // 真实底层推理协议决议：官方 spec -> fallback 表 -> 通用规则
    const wireProtocol = spec?.wireProtocol
      ?? (spec?.provider?.npm ? resolveProtocolFromNpm(spec.provider.npm) : undefined)
      ?? fallback?.wireProtocol
      ?? resolveOpenCodeModelProtocol(id, specs, fallbackModels)

    return {
      id,
      name,
      contextWindow,
      maxTokens,
      supportsImages,
      reasoning,
      billing,
      wireProtocol,
    }
  })
}

export interface OpenCodeUpstreamClientOptions {
  models?: readonly WorkBuddyUpstreamModel[]
  projectId?: string
  cachePath?: string
  specs?: Map<string, OpenCodeModelSpec>
}

/**
 * OpenCode upstream client: manages streaming chat completions with free tier gateway bypass
 * and dynamically synchronizes live free models and real capacities from upstream.
 */
export class OpenCodeUpstreamClient {
  private readonly models: readonly WorkBuddyUpstreamModel[]
  private readonly projectId: string
  private readonly cachePath?: string
  private specsCache?: Map<string, OpenCodeModelSpec>

  constructor(options: OpenCodeUpstreamClientOptions = {}) {
    this.models = options.models ?? []
    this.projectId = options.projectId ?? OPENCODE_DEFAULT_PROJECT_ID
    this.cachePath = options.cachePath
    this.specsCache = options.specs
  }

  private resolveSpecs(): Map<string, OpenCodeModelSpec> | undefined {
    if (this.specsCache !== undefined) return this.specsCache
    try {
      this.specsCache = readLocalOpenCodeSpecs(this.cachePath)
    } catch {
      this.specsCache = undefined
    }
    return this.specsCache
  }

  /** POST the chat completions endpoint with gateway bypass headers and tool guard */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    const sessionId = `ses_${generateOpenCodeId(true)}`
    const requestId = `msg_${generateOpenCodeId(false)}`
    const rawToken = credential.accessToken?.trim() ?? ''
    const token = rawToken !== ''
      && rawToken !== 'public'
      && !rawToken.includes('\n')
      && !rawToken.includes('\r')
      && !rawToken.startsWith('{')
      && !rawToken.startsWith('[')
      ? rawToken
      : 'public'
    const auth = `Bearer ${token}`

    let targetModel = ''
    try {
      const parsed = JSON.parse(bodyJson) as { model?: unknown }
      if (typeof parsed?.model === 'string') {
        targetModel = parsed.model.trim()
      }
    } catch {
      // ignore
    }

    const specs = this.resolveSpecs()
    const protocol = resolveOpenCodeModelProtocol(targetModel, specs, this.models)
    const endpoint = resolveOpenCodeEndpoint(targetModel, specs, this.models)

    let preparedBody: string
    if (protocol === 'anthropic-messages') {
      preparedBody = prepareOpenCodeAnthropicBody(bodyJson)
    } else {
      preparedBody = prepareOpenCodeChatBody(bodyJson)
    }

    const settled = await settleChatFetch(signal, async (fetchSignal) => {
      return fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, */*',
          'Authorization': auth,
          'User-Agent': OPENCODE_CLI_USER_AGENT,
          'X-Session-Id': sessionId,
          'x-opencode-client': 'cli',
          'x-opencode-project': this.projectId,
          'x-opencode-session': sessionId,
          'x-session-affinity': sessionId,
        },
        body: preparedBody,
        signal: fetchSignal,
      })
    })

    if (settled.settled) {
      if (settled.result.ok && settled.result.response.body) {
        if (protocol === 'responses') {
          const transformedBody = transformResponsesStreamToChatCompletions(settled.result.response.body, targetModel)
          return {
            ok: true,
            response: new Response(transformedBody, {
              status: settled.result.response.status,
              statusText: settled.result.response.statusText,
              headers: settled.result.response.headers,
            }),
          }
        }
        if (protocol === 'anthropic-messages') {
          const transformedBody = transformAnthropicStreamToChatCompletions(settled.result.response.body, targetModel)
          return {
            ok: true,
            response: new Response(transformedBody, {
              status: settled.result.response.status,
              statusText: settled.result.response.statusText,
              headers: settled.result.response.headers,
            }),
          }
        }
      }
      return settled.result
    }
    const { response, text } = settled
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
      headers: response.headers,
    }
  }

  async fetchModels(_credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    const modelsTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch(OPENCODE_MODELS_URL, {
        headers: {
          'user-agent': OPENCODE_CLI_USER_AGENT,
          'Accept': 'application/json',
        },
        signal: modelsTimeout.signal,
      })
      if (!response.ok) {
        return this.models
      }
      const json = await response.json() as OpenCodeModelsApiResponse
      const upstreamIds = Array.isArray(json?.data)
        ? json.data.map(row => typeof row?.id === 'string' ? row.id.trim() : '').filter(id => id !== '')
        : []
      if (upstreamIds.length === 0) {
        return this.models
      }
      const specs = this.resolveSpecs()
      return mergeOpenCodeCatalogue(this.models, upstreamIds, specs)
    } catch {
      return this.models
    } finally {
      modelsTimeout.dispose()
    }
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
