/**
 * upstream-workbuddy.ts — WorkBuddy（CodeBuddy / copilot.tencent.com）上游客户端。
 *
 * 2026-10-08 从 711 行拆出：纯解析进 upstream-workbuddy-parse.ts，基址/请求头/请求体/
 * 响应信封进 upstream-workbuddy-http.ts，本文件只留探针常量与客户端类（对外 API 不变）。
 *
 * @module dsh-any-connect/upstream-workbuddy
 */

import type { WorkBuddyCredential } from './auth.js'
import { appUserAgent, resolveAppVersion, type AppVersionInfo } from './app-version.js'
import type { ProbeAttempt } from './probe.js'
import { deadlineSignal, withTimeout } from './timeout.js'
import {
  JSON_TIMEOUT_MS,
  ERROR_BODY_LIMIT,
  CHAT_HEADER_TIMEOUT_MS,
  classifyUpstreamError,
  type WorkBuddyUpstreamModel,
  type WorkBuddyCreditAccount,
  type WorkBuddyCredits,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyChatResult,
} from './upstream-shared.js'
import { parseModelRow } from './upstream-workbuddy-parse.js'
import { CLIENT_UA, regionOf, chatBase, billingBase, originReferer, chatHeaders, refreshHeaders, billingHeaders, INTERNATIONAL_SYSTEM_PROMPT, prepareInternationalChatBody, readEnvelope, errorCodeOf, readFirstEvent, envelopeError } from './upstream-workbuddy-http.js'

const PROBE_PROMPT = 'ping'

/** Output ceiling for a probe request; the answer itself is never read. */
const PROBE_MAX_TOKENS = 1

/**
 * Output ceiling for an international probe request.
 *
 * Above the smallest value that the strictest observed model accepts (the
 * GPT-5.6 family rejects `1`), while still being far too small to produce a
 * real answer.
 */
const INTERNATIONAL_PROBE_MAX_TOKENS = 16

export interface WorkBuddyUpstreamClientOptions {
  /** Resolves the App-shaped UA version for international catalog requests;
   * injectable so tests never touch the real FS. */
  resolveAppVersion?: () => Promise<AppVersionInfo>
}

export class WorkBuddyUpstreamClient {
  private readonly resolveAppVersion: () => Promise<AppVersionInfo>

  constructor(options: WorkBuddyUpstreamClientOptions = {}) {
    this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion())
  }

  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    // 头超时与调用方取消经宿主 deadline 融合（此前手写 AbortController +
    // setTimeout + AbortSignal.any 三件套）：任一触发都中止请求，超时原因
    // 可分类（此前是裸 Error 字符串）。
    const headersTimeout = await deadlineSignal(signal, CHAT_HEADER_TIMEOUT_MS, 'ANY_CONNECT_HEADERS')
    const international = regionOf(credential.domain) === 'global'
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        // 国际网关硬性要求首条 system 消息（缺失即 400/11128），国内线不加。
        body: international ? prepareInternationalChatBody(bodyJson) : bodyJson,
        signal: headersTimeout.signal,
      })
    } catch (error: unknown) {
      // fetch 本身抛错（取消/传输错误/头超时）同样要拆掉定时器：超时回调对
      // 已 settled 的 controller 是无害 no-op，但定时器会继续挂住事件循环
      // 30s，连续失败的请求会积攒一堆待触发回调。
      headersTimeout.dispose()
      // 客户端主动断开（pi-ai 取消生成）不是上游故障，按 client 分类回报；
      // shim 对这类结果不向已销毁的 socket 回写错误。
      if (signal?.aborted) {
        return { ok: false, status: 0, kind: 'client', message: 'client disconnected before upstream response' }
      }
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) {
      headersTimeout.dispose() // 头已到：流式阶段不受头超时约束
      return { ok: true, response }
    }
    let text: string
    try {
      // 错误体读取仍在头超时的保护窗口内：上游发了头却卡住错误体时，
      // 定时器中止请求，这里按 server 分类兜底而非无限挂起。
      text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    } catch {
      return { ok: false, status: response.status, kind: 'server', message: '(error body unavailable)' }
    } finally {
      headersTimeout.dispose()
    }
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** Send one reasoning-effort probe request and classify the answer.
   *
   * The payload is minimal by design (prompt `ping`, tiny output ceiling):
   * the probe wants the accept/reject signal, never a completion. The
   * international body carries the gateway-required leading system prompt,
   * and the GPT-5.6 family's rejection of `max_tokens: 1` is why that region
   * asks for more.
   */
  async probeEffort(
    credential: WorkBuddyCredential,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    const international = regionOf(credential.domain) === 'global'
    const payload: Record<string, unknown> = {
      model,
      stream: true,
      messages: [
        ...international ? [{ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT }] : [],
        { role: 'user', content: PROBE_PROMPT },
      ],
      max_tokens: international ? INTERNATIONAL_PROBE_MAX_TOKENS : PROBE_MAX_TOKENS,
    }
    if (effort !== undefined) payload['reasoning_effort'] = effort

    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
      return { status: response.status, streamed: false, ...errorCodeOf(text) }
    }

    // Read until the first parseable event, then hang up: the probe wants the
    // acceptance signal, not a completion.
    const streamed = await readFirstEvent(response)
    return { status: response.status, streamed }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    // JSON 短读统一走宿主 deadline（超时原因可分类；此前裸 AbortSignal.timeout）。
    return withTimeout(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON', async (signal) => {
      const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
        method: 'POST',
        headers: refreshHeaders(credential),
        signal,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
      if (accessToken === '') throw new Error('workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app')
      const outcome: WorkBuddyRefreshOutcome = { accessToken }
      if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
      if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
      if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
      return outcome
    })
  }

  /** GET the personal model catalog and keep the `cli` agent's models only.
   *
   * International (`workbuddy-ai`) reads a different document: `/v3/config`,
   * the product document the gateway splits out by User-Agent, so this request
   * carries the App-shaped UA (`WorkBuddyAI/<v>`, no space — the space form is
   * rejected with 400, the CLI form gets a smaller document without
   * `modelPromotions`). All three shapes measured live on 2026-09-15.
   */
  async fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    const international = regionOf(credential.domain) === 'global'
    let userAgent = CLIENT_UA
    if (international) {
      // Resolution never throws, but an injected test double might: degrade to
      // the CLI form (smaller document, still usable) rather than no catalog.
      try {
        userAgent = appUserAgent((await this.resolveAppVersion()).version)
      } catch {
        userAgent = CLIENT_UA
      }
    }
    return withTimeout(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON', async (signal) => {
      const response = await fetch(
        `${chatBase(credential)}${international ? '/v3/config' : '/console/enterprises/personal/models'}`,
        {
          headers: {
            'Authorization': `Bearer ${credential.accessToken}`,
            'Accept': 'application/json',
            'Origin': originReferer(credential),
            'Referer': `${originReferer(credential)}/`,
            'User-Agent': userAgent,
            ...international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {},
          },
          signal,
        },
      )
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const data = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      const rawModels = Array.isArray(data['models']) ? data['models'] : []
      const agents = Array.isArray(data['agents']) ? data['agents'] : []
      let cliIds: readonly string[] | undefined
      for (const agent of agents) {
        if (typeof agent === 'object' && agent !== null) {
          const wrapped = agent as Record<string, unknown>
          if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
            cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
            break
          }
        }
      }
      if (cliIds === undefined || cliIds.length === 0) {
        throw new Error('workbuddy model catalog lists no cli agent models')
      }
      const promotions = international ? data['modelPromotions'] : undefined
      const byId = new Map<string, WorkBuddyUpstreamModel>()
      for (const model of rawModels) {
        if (typeof model !== 'object' || model === null) continue
        const parsed = parseModelRow(model as Record<string, unknown>, international, promotions)
        if (parsed !== undefined) byId.set(parsed.id, parsed)
      }
      const models = cliIds
        .map(id => byId.get(id))
        .filter((model): model is WorkBuddyUpstreamModel => model !== undefined)
      if (models.length === 0) throw new Error('workbuddy model catalog resolved to an empty list')
      return models
    })
  }

  /** POST the billing endpoint for the aggregated remaining credit. */
  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    return withTimeout(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON', async (signal) => {
      const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
        method: 'POST',
        headers: billingHeaders(credential),
        body: JSON.stringify({
          PageNumber: 1,
          PageSize: 100,
          ProductCode: 'p_tcaca',
          Status: [0, 3],
          PackageEndTimeRangeBegin: format(now),
          // 窗口上界沿用上游 CLI 的拼写：约 101 年（365×101 天），毫秒数。
          PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
        }),
        signal,
      })
      const envelope = await readEnvelope(response)
      if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
      const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
        ? envelope.data as Record<string, unknown>
        : {}
      const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
        ? responseWrapper['Response'] as Record<string, unknown>
        : {}
      const inner = typeof data['Data'] === 'object' && data['Data'] !== null
        ? data['Data'] as Record<string, unknown>
        : {}
      const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []
      const accounts: WorkBuddyCreditAccount[] = []
      let total = 0
      for (const raw of rawAccounts) {
        if (typeof raw !== 'object' || raw === null) continue
        const account = raw as Record<string, unknown>
        const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
        const size = numberField('CycleCapacitySize')
        const cycleRemain = numberField('CycleCapacityRemain')
        const cycleUsed = numberField('CycleCapacityUsed')
        const capacityRemain = numberField('CapacityRemain')
        const remainCycles = numberField('RemainCycles')
        let remain: number
        if (size > 0) {
          // True availability of a cyclic package = this cycle's remainder plus
          // the full grant of every cycle that has not started yet: a package
          // with its current cycle drained is not empty while RemainCycles > 0.
          remain = cycleRemain + remainCycles * size
        } else if (cycleRemain > 0 || cycleUsed > 0) {
          remain = cycleRemain
        } else {
          remain = capacityRemain
        }
        if (remain < 0) remain = 0
        total += remain
        accounts.push({
          packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
          remain,
          // The bar's denominator spans the same scope as the numerator: current
          // cycle plus the not-yet-started ones.
          size: size > 0 ? size * (1 + remainCycles) : numberField('CapacitySize'),
        })
      }
      return { total, accounts }
    })
  }
}

export { regionOf, chatBase, prepareChatBody, prepareInternationalChatBody } from './upstream-workbuddy-http.js'
export type { WorkBuddyRegion } from './upstream-workbuddy-http.js'
