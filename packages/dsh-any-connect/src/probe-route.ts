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
 * 2. **An in-process random key**, minted per process and handed only to the
 *    same-origin card. Loopback alone is *not* authentication — any local
 *    process can write `Host: 127.0.0.1` — so a route that spends the user's
 *    credit must prove the caller was told the key.
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
import { hostIsLoopback, originIsLoopback } from './loopback.js'
import { safeMessage } from './web-status.js'
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
  /**
   * Route path to mount. Defaults to the CN variant's path so existing callers
   * and tests keep their behaviour; the international variant passes its own.
   */
  path?: string
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

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
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
  // No payload: the variant is already known from the route the request arrived
  // on, so the browser cannot ask this route to refresh a different provider.
  if (wrapped['action'] === 'refresh') return { action: 'refresh' }
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
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers['x-workbuddy-probe-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-probe-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const action = parseAction(body)
    if (action === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      if (deps.refresh === undefined) {
        json(res, 404, { error: 'refresh-not-supported' })
        return
      }
      json(res, 200, await deps.refresh())
    } catch (error: unknown) {
      // 与 web-status 的 500 兜底同一脱敏口径:refresh 是注入点,自定义实
      // 现抛出的错误可能携带凭据材料,不能裸透传到浏览器。
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the POST probe-control route on an optional webServer context. */
export function registerWorkBuddyProbeRoute(
  ctx: Context,
  deps: WorkBuddyProbeRouteOptions,
  key: string,
): void {
  const path = deps.path ?? WORKBUDDY_PROBE_PATH
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: workBuddyProbeHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-any-connect: probe control route')
}
