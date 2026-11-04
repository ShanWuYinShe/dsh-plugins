/**
 * Probe control route: the only state-changing endpoint the plugin exposes.
 *
 * Ported from corrinehu/dsh-workbuddy-connect `src/probe-route.ts` (MIT).
 * Effort detection itself is automatic (the probe service sweeps missing
 * candidates after every catalog refresh), so the card has exactly one write
 * to request here: a catalog refresh. Two guards, because they stop different
 * things:
 *
 * 1. **Loopback Host + Origin**, shared with the status route. This drops
 *    DNS-rebinding pages, whose requests arrive addressed to the attacker's
 *    domain.
 * 2. **Strict same-origin**: `Origin` must equal `http(s)://<Host>` — i.e. the
 *    caller is the host page itself, not just "some loopback page". 其他本地
 *    Web 应用同样跑在 127.0.0.1 的其它端口上；「环回」不等于「宿主页面」。
 * 3. **An in-process random key**, minted per process and handed only to the
 *    same-origin card (status 文档只在 `Sec-Fetch-Site: same-origin` 下下发，
 *    见 web-status.ts 的威胁模型注释）. Loopback alone is *not* authentication — any
 *    local process can write `Host: 127.0.0.1` — so a route that spends the
 *    user's credit must prove the caller was told the key.
 *
 * The route never accepts a prompt, a model id, or a sentinel from the
 * browser: a probe request is assembled entirely host-side.
 *
 * @module dsh-any-connect/probe-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback, requestIsSameOrigin } from './loopback.js'
import { safeMessage } from './values.js'
import { writeJson } from './shim-http.js'
import { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_PROBE_PATH } from './status-paths.js'
import type { WorkBuddyProbeAction } from './status-paths.js'

export { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_PROBE_PATH }

/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Constructor dependencies. */
export interface WorkBuddyProbeRouteOptions {
  /**
   * Re-read the credential and re-fetch the model catalog for this variant.
   *
   * It lives on this route rather than the status GET because it is a write
   * that spends a request against the upstream: the read-only status route's
   * loopback guard protects against a rebinding *page*, which is not the same
   * as authorizing an action. Requires the in-process key.
   */
  refresh?: () => Promise<{ state: string; reason?: string }>
  /** Exclude a model from the active roster. */
  deleteModel?: (modelId: string) => Promise<{ state: string; excludedCount?: number }>
  /**
   * Restore ONE excluded model.
   *
   * `restored` is false when the id was not actually hidden (a stale card, or a
   * double click) — reported rather than treated as an error, because the
   * caller's intent ("make it visible") already holds.
   */
  restoreModel?: (modelId: string) => Promise<{ state: string; restored?: boolean; excludedCount?: number }>
  /** Restore all excluded models back to default. */
  restoreModels?: () => Promise<{ state: string; excludedCount?: number }>
  /** Route path to mount; one per variant (五个变体各有一条）。 */
  path: string
}

/** Mint the per-process control key. */
export function createProbeKey(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Constant-time key comparison; a length mismatch is a failure, not a crash.
 */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Read the request body with a hard ceiling. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text: string): WorkBuddyProbeAction | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  if (wrapped['action'] === 'refresh') return { action: 'refresh' }
  if (wrapped['action'] === 'delete-model') {
    const modelId = wrapped['modelId']
    if (typeof modelId === 'string' && modelId.trim().length > 0) {
      return { action: 'delete-model', modelId: modelId.trim() }
    }
    return undefined
  }
  if (wrapped['action'] === 'restore-model') {
    const modelId = wrapped['modelId']
    if (typeof modelId === 'string' && modelId.trim().length > 0) {
      return { action: 'restore-model', modelId: modelId.trim() }
    }
    return undefined
  }
  if (wrapped['action'] === 'restore-models') return { action: 'restore-models' }
  return undefined
}

/**
 * The control route's handler, extracted so tests can mount it on a bare
 * server with a known key.
 */
export function workBuddyProbeHandler(
  deps: WorkBuddyProbeRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed' })
      return
    }
    // 两道守卫各挡一类调用方（威胁模型见模块头）：
    // 1) Host/Origin 环回：挡 DNS 重绑定页面（请求被指到攻击者域名）；
    // 2) **严格同源**：Origin 必须逐字等于 http(s)://<Host>。任意环回 Origin
    //    不够——本地另一个端口上的页面/开发服务器同样是环回，却不是宿主页面。
    //    写路由会持久化改用户的隐藏模型清单并触发上游请求，必须限定同源
    //    浏览器上下文（浏览器自己写 Origin，跨源页面无法伪装）。
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      writeJson(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!requestIsSameOrigin(req.headers.origin, req.headers.host)) {
      writeJson(res, 403, { error: 'cross-origin-rejected' })
      return
    }
    if (!keyMatches(key, req.headers['x-workbuddy-probe-key'] as string | undefined)) {
      writeJson(res, 403, { error: 'invalid-probe-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      writeJson(res, 413, { error: 'body too large' })
      return
    }
    const action = parseAction(body)
    if (action === undefined) {
      writeJson(res, 400, { error: 'invalid action' })
      return
    }
    try {
      if (action.action === 'refresh') {
        if (deps.refresh === undefined) {
          writeJson(res, 404, { error: 'refresh-not-supported' })
          return
        }
        writeJson(res, 200, await deps.refresh())
        return
      }
      if (action.action === 'delete-model') {
        if (deps.deleteModel === undefined) {
          writeJson(res, 404, { error: 'delete-model-not-supported' })
          return
        }
        writeJson(res, 200, await deps.deleteModel(action.modelId))
        return
      }
      if (action.action === 'restore-model') {
        if (deps.restoreModel === undefined) {
          writeJson(res, 404, { error: 'restore-model-not-supported' })
          return
        }
        writeJson(res, 200, await deps.restoreModel(action.modelId))
        return
      }
      if (action.action === 'restore-models') {
        if (deps.restoreModels === undefined) {
          writeJson(res, 404, { error: 'restore-models-not-supported' })
          return
        }
        writeJson(res, 200, await deps.restoreModels())
        return
      }
    } catch (error: unknown) {
      // 与 web-status 的 500 兜底同一脱敏口径:refresh 是注入点,自定义实
      // 现抛出的错误可能携带凭据材料,不能裸透传到浏览器。
      writeJson(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the POST probe-control route on an optional webServer context. */
export function registerWorkBuddyProbeRoute(
  ctx: Context,
  deps: WorkBuddyProbeRouteOptions,
  key: string,
): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: deps.path,
      handler: workBuddyProbeHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-any-connect: probe control route')
}
