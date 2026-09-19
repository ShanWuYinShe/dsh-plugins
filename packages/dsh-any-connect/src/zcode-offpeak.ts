/**
 * zcode off-peak（夜间免费）通道：票据状态机 + Anthropic Messages 中继直通。
 *
 * 夜间免费走的是与直连完全独立的一条面：模型请求打
 * `https://zcode.z.ai/api/v1/off-peak/anthropic`，鉴权是
 * `Authorization: Bearer <JWT>` + `X-Coding-Plan-Api-Key` +
 * `X-Off-Peak-Ticket-ID`（zcode 生产代码为规范大写 X-Off-Peak-Ticket-ID）。
 * 票据从 `https://zcode.z.ai/api/v1/off-peak/ticket*` 排队系统获取：
 *
 * - `GET  /ticket/availability` → `{can_take_number, next_take_at?}`（窗口
 *   与配额完全服务端裁决，客户端不判断时段）；
 * - `POST /ticket {task_id}` → `{ticket_id, state, position?, next_poll_after?}`；
 * - `POST /ticket/status {ticket_ids}` → 按服务端下发的 `next_poll_after`
 *   轮询，`queued → ready|active`；`expired` 重新取票；
 * - 业务码：`3101` 无可用 Coding Plan、`3103` 免费配额用尽、`3102` 票据
 *   失效（换票重试一次）、`3105` 排队中（可重试）。
 *
 * @module dsh-any-connect/zcode-offpeak
 */

import { randomUUID } from 'node:crypto'
import type { WorkBuddyAuthStatus } from './auth.js'
import { readZcodeClientCredentials, zcodeDeviceMid } from './zcode-credentials.js'
import type { ZcodeChatResult, ZcodeUpstreamLogger } from './zcode-upstream.js'
import { ZCODE_ANTHROPIC_VERSION } from './zcode-upstream.js'

export type { ZcodeChatResult } from './zcode-upstream.js'

/** off-peak 中继与票据系统的公共基座。 */
export const ZCODE_OFFPEAK_BASE = 'https://zcode.z.ai/api/v1/off-peak'

/** off-peak 凭据：JWT + plan key 缺一不可。 */
export interface ZcodeOffpeakCredential {
  jwt: string
  planApiKey: string
}

/** 票据状态（服务端枚举）。 */
export type ZcodeOffpeakTicketState = 'queued' | 'ready' | 'active' | 'expired' | 'settled' | 'not_found'

/** 票据系统不可用的可诊断错误（时段未开/无资格/配额尽/排队超时）。 */
export class ZcodeOffpeakUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeOffpeakUnavailableError'
  }
}

/** 默认排队等待上限：超过即如实报错（位置信息一并带给用户），不无限等。 */
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 180_000

/** 服务端轮询间隔的缺省与上限（next_poll_after 缺席/过大时）。 */
const DEFAULT_POLL_AFTER_MS = 5_000
const MAX_POLL_AFTER_MS = 60_000

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }, { once: true })
  })
}

/** 成功信封 `{code:0, data:...}` → data；其他形状原样交由调用方报错。 */
function extractData(body: string): unknown {
  try {
    const parsed = JSON.parse(body) as { code?: number; data?: unknown }
    return parsed.code === 0 ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** 票据状态机：一个进程持一张活动票（会话内多请求复用，失效即换）。 */
export class ZcodeOffpeakTickets {
  private active: { ticketId: string } | undefined
  private readonly identityHeaders: () => Record<string, string>
  private readonly logger: ZcodeUpstreamLogger | undefined
  private readonly queueWaitTimeoutMs: number

  constructor(options: {
    identityHeaders: () => Record<string, string>
    logger?: ZcodeUpstreamLogger
    queueWaitTimeoutMs?: number
  }) {
    this.identityHeaders = options.identityHeaders
    this.logger = options.logger
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs ?? DEFAULT_QUEUE_WAIT_TIMEOUT_MS
  }

  /** 当前活动票（信任到被 3102 打脸为止）。 */
  currentTicket(): string | undefined {
    return this.active?.ticketId
  }

  /** 主动弃票（3102 换票、进程清理）。 */
  invalidate(): void {
    this.active = undefined
  }

  /** 只读的窗口探测：不取号、不消费。诊断与状态卡用。 */
  async availability(credential: ZcodeOffpeakCredential, signal: AbortSignal): Promise<{ canTakeNumber: boolean; nextTakeAt: number | undefined }> {
    const response = await this.call(`${ZCODE_OFFPEAK_BASE}/ticket/availability`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${credential.jwt}`,
        'x-coding-plan-api-key': credential.planApiKey,
        ...this.identityHeaders(),
      },
    }, signal)
    if (!response.ok) {
      throw new ZcodeOffpeakUnavailableError(`off-peak availability check failed (http ${response.status}): ${response.body.slice(0, 200)}`)
    }
    const data = extractData(response.body) as { can_take_number?: boolean; next_take_at?: number } | undefined
    return { canTakeNumber: data?.can_take_number === true, nextTakeAt: data?.next_take_at }
  }

  /** 取一张可用票：窗口未开/无资格/配额尽抛 {@link ZcodeOffpeakUnavailableError}。 */
  async ensure(credential: ZcodeOffpeakCredential, signal: AbortSignal): Promise<string> {
    if (this.active !== undefined) return this.active.ticketId
    const base = {
      authorization: `Bearer ${credential.jwt}`,
      'x-coding-plan-api-key': credential.planApiKey,
      ...this.identityHeaders(),
    }
    // 1) 窗口与资格探测（只读）。
    const availability = await this.call(`${ZCODE_OFFPEAK_BASE}/ticket/availability`, { method: 'GET', headers: base }, signal)
    if (!availability.ok) {
      throw new ZcodeOffpeakUnavailableError(`off-peak availability check failed (http ${availability.status}): ${availability.body.slice(0, 200)}`)
    }
    const availabilityData = extractData(availability.body) as { can_take_number?: boolean; next_take_at?: number } | undefined
    if (availabilityData?.can_take_number !== true) {
      throw new ZcodeOffpeakUnavailableError(
        availabilityData?.next_take_at === undefined
          ? 'off-peak window is not taking numbers right now'
          : `off-peak window closed; next take at ${new Date(availabilityData.next_take_at * 1000).toISOString()}`,
      )
    }
    // 2) 取号。
    const take = await this.call(`${ZCODE_OFFPEAK_BASE}/ticket`, {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: randomUUID() }),
    }, signal)
    if (!take.ok) {
      throw new ZcodeOffpeakUnavailableError(`off-peak ticket request failed (http ${take.status}): ${take.body.slice(0, 200)}`)
    }
    const taken = extractData(take.body) as
      | { ticket_id?: string; state?: ZcodeOffpeakTicketState; position?: number; next_poll_after?: number }
      | undefined
    if (typeof taken?.ticket_id !== 'string') {
      throw new ZcodeOffpeakUnavailableError(`off-peak ticket response missing ticket_id: ${take.body.slice(0, 200)}`)
    }
    // 已 ready/active 直接入缓存；queued 进轮询。
    if (taken.state === 'ready' || taken.state === 'active') {
      this.active = { ticketId: taken.ticket_id }
      return taken.ticket_id
    }
    // 3) 排队轮询：间隔用服务端 next_poll_after，总时长有上限。
    const deadline = Date.now() + this.queueWaitTimeoutMs
    let ticketId = taken.ticket_id
    let state: ZcodeOffpeakTicketState = taken.state ?? 'queued'
    let position = taken.position
    let pollAfterMs = pollAfterFromSeconds(taken.next_poll_after)
    while (state === 'queued') {
      if (Date.now() > deadline) {
        throw new ZcodeOffpeakUnavailableError(
          position === undefined
            ? `off-peak queue wait exceeded ${Math.round(this.queueWaitTimeoutMs / 1000)}s`
            : `off-peak queue wait exceeded ${Math.round(this.queueWaitTimeoutMs / 1000)}s (position ${position})`,
        )
      }
      await sleep(pollAfterMs, signal)
      const status = await this.call(`${ZCODE_OFFPEAK_BASE}/ticket/status`, {
        method: 'POST',
        headers: { ...base, 'content-type': 'application/json' },
        body: JSON.stringify({ ticket_ids: [ticketId] }),
      }, signal)
      if (!status.ok) {
        throw new ZcodeOffpeakUnavailableError(`off-peak ticket status failed (http ${status.status}): ${status.body.slice(0, 200)}`)
      }
      const statusData = extractData(status.body) as
        | { tickets?: Array<{ ticket_id?: string; state?: ZcodeOffpeakTicketState; position?: number }>; next_poll_after?: number }
        | undefined
      const row = statusData?.tickets?.find(entry => entry.ticket_id === ticketId)
      if (row === undefined) {
        throw new ZcodeOffpeakUnavailableError('off-peak ticket vanished from status')
      }
      state = row.state ?? 'queued'
      position = row.position ?? position
      pollAfterMs = pollAfterFromSeconds(statusData?.next_poll_after)
      if (state === 'ready' || state === 'active') {
        this.active = { ticketId }
        return ticketId
      }
      if (state === 'expired') {
        // 票过期：弃号重取（递归一层，窗口仍在则拿新票）。
        this.invalidate()
        return this.ensure(credential, signal)
      }
      if (state !== 'queued') {
        throw new ZcodeOffpeakUnavailableError(`off-peak ticket entered terminal state ${state}`)
      }
    }
    throw new ZcodeOffpeakUnavailableError('off-peak queue exited unexpectedly')
  }

  /** 任务终态后礼貌结票（尽力而为，失败静默——票据自然过期兜底）。 */
  async settle(credential: ZcodeOffpeakCredential, ticketId: string): Promise<void> {
    try {
      await this.call(`${ZCODE_OFFPEAK_BASE}/ticket/${encodeURIComponent(ticketId)}/settle`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.jwt}`,
          'x-coding-plan-api-key': credential.planApiKey,
          ...this.identityHeaders(),
        },
      }, AbortSignal.timeout(10_000))
    } catch {
      // 结票失败不影响主流程。
    } finally {
      if (this.active?.ticketId === ticketId) this.active = undefined
    }
  }

  /** 统一的票据系统请求；4xx body 原样返回，供调用方识别 3101/3102/3103/3105。
   * 设备 id 随请求携带（zcode 的设备头语义）。 */
  private async call(url: string, init: RequestInit, signal: AbortSignal): Promise<{ ok: boolean; status: number; body: string }> {
    const headers = new Headers(init.headers)
    headers.set('x-device-mid', await zcodeDeviceMid())
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
    const body = await response.text()
    return { ok: response.ok, status: response.status, body }
  }
}

function pollAfterFromSeconds(seconds: number | undefined): number {
  const ms = (seconds ?? 0) * 1000
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_POLL_AFTER_MS
  return Math.min(MAX_POLL_AFTER_MS, ms)
}

/**
 * off-peak 凭据 store：只跟随 zcode（JWT 没有手动获取路径——它由 zcode 的
 * OAuth 会话签发）。zcode 未登录 → 未配置；凭据文件损坏 → status 降级为
 * signed-out + reason（与直连 store 同一诊断姿态）。
 */
export class ZcodeOffpeakCredentialStore {
  private readonly zcodeCredentialsPath: string | undefined

  constructor(options: { zcodeCredentialsPath?: string } = {}) {
    this.zcodeCredentialsPath = options.zcodeCredentialsPath
  }

  /** The usable credential, or undefined while zcode is not signed in. */
  async current(): Promise<ZcodeOffpeakCredential | undefined> {
    const credentials = await readZcodeClientCredentials(
      this.zcodeCredentialsPath === undefined ? {} : { path: this.zcodeCredentialsPath },
    )
    if (credentials === undefined || credentials.jwt === undefined) return undefined
    return { jwt: credentials.jwt, planApiKey: credentials.planApiKey }
  }

  /** The usable credential, or a descriptive error. */
  async resolve(): Promise<ZcodeOffpeakCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error('zcode off-peak needs both the plan API key and the zcode session JWT; sign in to the zcode desktop app')
    }
    return credential
  }

  /** Sign-in summary for the status card. */
  async status(): Promise<WorkBuddyAuthStatus> {
    let credential: ZcodeOffpeakCredential | undefined
    try {
      credential = await this.current()
    } catch (error: unknown) {
      return { state: 'signed-out', reason: error instanceof Error ? error.message : String(error) }
    }
    if (credential === undefined) {
      return { state: 'signed-out', reason: 'zcode 会话凭据缺失（需在 zcode 桌面端登录一次）' }
    }
    return { state: 'signed-in', source: 'dsh' }
  }

  /** RuntimeStore 的形状要求；off-peak 凭据属于 zcode，无可清理的自有副本。 */
  async logout(): Promise<void> {}
}

/** off-peak 上游客户端：确保票据 → 带票直通中继。 */
export class ZcodeOffpeakUpstreamClient {
  readonly sessionId = randomUUID()

  readonly tickets: ZcodeOffpeakTickets
  private readonly logger: ZcodeUpstreamLogger | undefined
  private readonly identity: () => Record<string, string>

  constructor(options: {
    identityHeaders: () => Record<string, string>
    logger?: ZcodeUpstreamLogger
    queueWaitTimeoutMs?: number
  }) {
    this.identity = options.identityHeaders
    this.logger = options.logger
    this.tickets = new ZcodeOffpeakTickets(options)
  }

  /** 票据被 3102 拒后弃票重试一次（换新票）；其余结果原样中继。 */
  async forwardMessages(
    credential: ZcodeOffpeakCredential,
    rawBody: string,
    signal: AbortSignal,
  ): Promise<ZcodeChatResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let ticket: string
      try {
        ticket = await this.tickets.ensure(credential, signal)
      } catch (error: unknown) {
        if (error instanceof ZcodeOffpeakUnavailableError) {
          return {
            ok: false,
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { type: 'off_peak_unavailable', message: error.message } }),
          }
        }
        throw error
      }
      const response = await fetch(`${ZCODE_OFFPEAK_BASE}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          ...this.identity(),
          'x-device-mid': await zcodeDeviceMid(),
          'x-request-id': randomUUID(),
          'x-session-id': this.sessionId,
          'x-zcode-session-type': 'main',
          'x-zcode-trace-id': randomUUID(),
          'content-type': 'application/json',
          'anthropic-version': ZCODE_ANTHROPIC_VERSION,
          authorization: `Bearer ${credential.jwt}`,
          'x-coding-plan-api-key': credential.planApiKey,
          'x-off-peak-ticket-id': ticket,
        },
        body: rawBody,
        signal,
      })
      if (response.ok) return { ok: true, status: response.status, response }
      const contentType = response.headers.get('content-type') ?? undefined
      const body = (await response.text()).slice(0, 4000)
      // 3102 = 票据失效：弃票；首轮再取新票重试一次，次轮如实返回。
      if (response.status === 400 && body.includes('3102') && attempt === 0) {
        this.logger?.warn('dsh-any-connect: zcode off-peak ticket rejected (3102); retaking a ticket')
        this.tickets.invalidate()
        continue
      }
      return { ok: false, status: response.status, contentType, body }
    }
    throw new Error('unreachable: off-peak retry loop exhausted without returning')
  }
}
