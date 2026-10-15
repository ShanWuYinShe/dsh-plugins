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
  type WorkBuddyUpstreamModel,
  type WorkBuddyCredits,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyChatResult,
} from './upstream-shared.js'

export const OPENCODE_BASE_URL = 'https://opencode.ai'
export const OPENCODE_CHAT_COMPLETIONS_URL = 'https://opencode.ai/inference/v1/chat/completions'
export const OPENCODE_MODELS_URL = 'https://opencode.ai/inference/v1/models'
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
export function defaultOpenCodeCachePath(): string {
  if (process.env.OPENCODE_MODELS_CACHE) {
    return process.env.OPENCODE_MODELS_CACHE
  }
  const home = homedir()
  const xdgCache = process.env.XDG_CACHE_HOME || join(home, '.cache')
  return join(xdgCache, 'opencode', 'models.json')
}

/**
 * 读取本地 OpenCode 官方模型元数据规范（含真实 contextWindow, maxTokens, attachment）。
 */
export function readLocalOpenCodeSpecs(cachePath: string = defaultOpenCodeCachePath()): Map<string, OpenCodeModelSpec> | undefined {
  try {
    if (!existsSync(cachePath)) return undefined
    const text = readFileSync(cachePath, 'utf8')
    const json = JSON.parse(text) as { opencode?: { models?: Record<string, OpenCodeModelSpec> } }
    if (!json?.opencode?.models || typeof json.opencode.models !== 'object') return undefined
    return new Map(Object.entries(json.opencode.models))
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

    return {
      id,
      name,
      contextWindow,
      maxTokens,
      supportsImages,
      reasoning,
      billing,
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
