/**
 * Same-origin status route for the WorkBuddy plugin card: sign-in state,
 * token expiry, and remaining credit, fetched by the browser half. The route
 * answers loopback browser requests only and never carries token material.
 *
 * @module dsh-any-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyAuthStatus, WorkBuddyCredential } from './auth.js'
import type { WorkBuddyCredits } from './upstream.js'
import { normalizeCredits } from './upstream.js'
import type { WorkBuddyModelInfo } from './catalog.js'
import { hostIsLoopback, originIsLoopback } from './loopback.js'
import { WORKBUDDY_STATUS_PATH } from './status-paths.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebModelRow, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from './status-paths.js'

export { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from './status-paths.js'
export type { WorkBuddyWebCatalog, WorkBuddyWebModelRow, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from './status-paths.js'

/** Constructor dependencies. */
export interface WorkBuddyStatusRouteOptions {
  /**
   * Structural minimum both credential stores satisfy: sign-in summary for
   * the document, and the current credential (opaque; only consumed when
   * {@link fetchCredits} is provided, which is WorkBuddy-only).
   */
  store: {
    status(): Promise<WorkBuddyAuthStatus>
    current(): Promise<unknown>
  }
  /** Live billing answer for the card's credit section. */
  fetchCredits?: (credential: WorkBuddyCredential) => Promise<WorkBuddyCredits>
  /** Resolve the current model catalog for the card's unified model list. */
  models: () => readonly WorkBuddyModelInfo[]
  /** Resolve where the served models came from, for the card's catalog line. */
  catalog: () => WorkBuddyWebCatalog
  /** Resolve the probe section, for the card's detection controls. Omitted hides it. */
  probe?: () => WorkBuddyWebProbeSection
  /** In-process key authorizing probe control writes; handed to the card. */
  probeKey: string
  /** Route path; one per variant. */
  path: string
}

/** Redact token-like content before it crosses to the browser.
 * 导出供 probe-route 的 500 兜底复用:同包内错误文本过线前脱敏必须同一
 * 口径,两份手抄曾在本仓其他包发生过规则漂移。
 */
export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    // api_?key= 与 provider-usage 的 safeMessage 规则集对齐:跨包独立发布
    // 不能互 import,但脱敏规则集应保持等价。
    .replace(/(\b(?:code|token|refresh_token|access_token|api_?key)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}


/**
 * Assemble the card's status document. Sign-in state is read-only; credit is
 * a live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 */
export async function workBuddyWebStatus(
  deps: WorkBuddyStatusRouteOptions,
): Promise<WorkBuddyWebStatus> {
  const authStatus = await deps.store.status()
  if (authStatus.state !== 'signed-in') {
    return authStatus.reason === undefined ? { status: 'signed-out' } : { status: 'signed-out', reason: authStatus.reason }
  }
  const status: WorkBuddyWebStatus = {
    status: 'signed-in',
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...authStatus.source === undefined ? {} : { source: authStatus.source },
    ...authStatus.expiresAtMs === undefined ? {} : { expiresAt: authStatus.expiresAtMs },
    catalog: deps.catalog(),
    ...deps.probe === undefined ? {} : { probe: deps.probe() },
    probeKey: deps.probeKey,
  }
  // One unified row per served model: display name, working window, billing
  // facts, declared efforts, and the larger selectable windows. The rate is
  // normalized here (not in the card) so both halves agree on one display
  // form; the card additionally localizes badge labels.
  const models: readonly WorkBuddyWebModelRow[] = deps.models().map(model => {
    const rate = model.billing?.free === true ? undefined : normalizeCredits(model.billing?.credits)
    const efforts = model.reasoning?.supportedEfforts
    return {
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      largerWindows: [...(model.supportedContextWindows ?? [])]
        .filter(windows => windows > model.contextWindow)
        .sort((a, b) => a - b),
      ...model.billing?.free === true ? { free: true as const } : {},
      ...model.billing?.badges !== undefined && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
      ...rate === undefined ? {} : { credits: rate },
      ...model.billing?.rateUnknown === true ? { rateUnknown: true as const } : {},
      ...efforts === undefined || efforts.length === 0 ? {} : { efforts: [...efforts] },
    }
  })
  const statusWithModels: WorkBuddyWebStatus = { ...status, models }
  try {
    if (deps.fetchCredits !== undefined) {
      const credential = await deps.store.current()
      if (credential !== undefined) {
        const credits = await deps.fetchCredits(credential as WorkBuddyCredential)
        return { ...statusWithModels, credits }
      }
    }
  } catch (error: unknown) {
    return { ...statusWithModels, creditsError: safeMessage(error) }
  }
  return statusWithModels
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyStatusRoute(ctx: Context, deps: WorkBuddyStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: deps.path,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET') {
          json(res, 405, { error: 'method not allowed' })
          return
        }
        // 与探针路由同口径：Host 必环回（挡 DNS 重绑定导航/表单）+
        // Origin 必环回（挡跨站读），缺一即 403。
        if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
          json(res, 403, { error: 'request-not-trusted' })
          return
        }
        try {
          json(res, 200, await workBuddyWebStatus(deps))
        } catch (error: unknown) {
          json(res, 500, { error: safeMessage(error) })
        }
      },
    })
    return () => {
      dispose()
    }
  }, 'dsh-any-connect: Web status route')
}
