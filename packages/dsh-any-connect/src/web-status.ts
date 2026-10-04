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
import type { WorkBuddyWebCatalog, WorkBuddyWebModelRow, WorkBuddyWebProbeSection, WorkBuddyWebStartPlanClaim, WorkBuddyWebStatus } from './status-paths.js'
import type { StartPlanPreviewResult } from './zcode-plan-claim.js'

// `WorkBuddyWebStartPlanClaim` 的形状定义在 status-paths.ts（客户端与宿主共用同一
// 份契约，避免两处各写一遍后漂移）。这里只转出，不再重复声明。

export { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from './status-paths.js'
export type { WorkBuddyWebCatalog, WorkBuddyWebModelRow, WorkBuddyWebProbeSection, WorkBuddyWebStartPlanClaim, WorkBuddyWebStatus } from './status-paths.js'

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
  /**
   * 今日 Start Plan 待领取探测；只由 Start Plan 变体提供，其余变体省略即不出
   * 该字段。**必须是短超时且不抛错的**：它挂在卡片每 60s 轮询的读路径上，一次
   * 挂死的上游不能拖住整份 status 文档。
   */
  fetchStartPlanClaim?: (credential: WorkBuddyCredential) => Promise<StartPlanPreviewResult>
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
  const statusWithClaim = { ...statusWithModels, ...await startPlanClaimSection(deps) }
  try {
    if (deps.fetchCredits !== undefined) {
      const credential = await deps.store.current()
      if (credential !== undefined) {
        const credits = await deps.fetchCredits(credential as WorkBuddyCredential)
        return { ...statusWithClaim, credits }
      }
    }
  } catch (error: unknown) {
    return { ...statusWithClaim, creditsError: safeMessage(error) }
  }
  return statusWithClaim
}

/**
 * 今日 Start Plan 领取提示（仅 Start Plan 变体）。
 *
 * 三种状态的映射是这一段的核心：
 * - 探测成功且清单非空 -> `available`（带 plan_id/name + captchaRequired）；
 * - 探测成功但清单为空 -> `none`（今日已领取，是**正常**结论）；
 * - 探测失败/超时/没凭据 -> `unknown`（**绝不塌成 none**）。
 *
 * 本函数自身**从不抛错**：status 是卡片的读路径，一次探测故障不能把整份文档
 * 变成 500。任何异常都在这里收敛成 `unknown` + 脱敏原因。
 */
async function startPlanClaimSection(
  deps: WorkBuddyStatusRouteOptions,
): Promise<{ startPlanClaim?: WorkBuddyWebStartPlanClaim }> {
  if (deps.fetchStartPlanClaim === undefined) return {}
  try {
    const credential = await deps.store.current()
    if (credential === undefined) return { startPlanClaim: { state: 'unknown', reason: '未读取到凭据' } }
    const preview = await deps.fetchStartPlanClaim(credential as WorkBuddyCredential)
    if (preview.status === 'ok') {
      const first = preview.plans[0]
      if (first === undefined) return { startPlanClaim: { state: 'none' } }
      return {
        startPlanClaim: {
          state: 'available',
          planId: first.planId,
          ...first.name === undefined ? {} : { planName: first.name },
          // 领取必须过一次阿里云验证码（客户端渲染进程签发，Node 侧无法生成），
          // 所以插件能自动做的到此为止：探测自动、领取手动。
          captchaRequired: true,
        },
      }
    }
    return { startPlanClaim: { state: 'unknown', reason: safeMessage(preview.message) } }
  } catch (error: unknown) {
    return { startPlanClaim: { state: 'unknown', reason: safeMessage(error) } }
  }
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
