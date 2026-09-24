/**
 * Same-origin route the browser half polls for the current provider's usage.
 *
 * The route answers an explicit list of providers rather than "whatever the
 * session uses", because the host has no idea which provider the browser is
 * looking at: the Session's selection lives on the client. The browser asks
 * for the one provider it needs, and this route answers only providers that
 * have a querier — an unknown route is a 200 with a null answer, not a 404,
 * so the surface can distinguish "no querier" from "route missing".
 *
 * @module provider-usage/route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ProviderUsageRegistry } from './registry.js'
import { PROVIDER_USAGE_PATH } from './types.js'

/** Constructor dependencies. */
export interface ProviderUsageRouteOptions {
  registry: ProviderUsageRegistry
  /** Route path; defaults to the shared constant. */
  path?: string
  /** Upper bound on the provider list one request may ask for. */
  maxProviders?: number
}

/** Largest provider list one request may name. */
const DEFAULT_MAX_PROVIDERS = 20

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, '[redacted key]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Loopback guards. Semantics mirror dsh-any-connect's `src/loopback.ts`
 * (kept as a local copy: the two packages ship independently and cannot
 * import each other — intentional drift-toward-rejection if they diverge).
 *
 * Usage is account-level information: a request without an origin is a
 * same-origin fetch from the served page (browsers omit it on some GETs),
 * and any other origin is a cross-site read attempt. The Host check
 * additionally drops DNS-rebinding navigation/form requests, which carry
 * no Origin but send the attacker's domain in Host.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end === -1) return hostname
    const rest = hostname.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return hostname
    return hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    // WHATWG URL returns IPv6 hostnames bracketed.
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** Parse the comma-separated `providers` query parameter. */
function requestedProviders(url: URL, max: number): readonly string[] {
  const raw = url.searchParams.get('providers')
  if (raw === null || raw.trim() === '') return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const provider = part.trim()
    if (provider !== '') seen.add(provider)
    if (seen.size >= max) break
  }
  return [...seen]
}

/**
 * Answer one usage read.
 *
 * @param options - registry and route configuration.
 * @returns the Node request handler.
 */
export function providerUsageHandler(options: ProviderUsageRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const max = options.maxProviders ?? DEFAULT_MAX_PROVIDERS
  return async (req, res) => {
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
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      const providers = requestedProviders(url, max)
      // Sequential rather than parallel: these are billing endpoints, and
      // firing twenty at once from one page poll is how an account gets
      // rate-limited for merely displaying a number.
      const snapshots: unknown[] = []
      for (const provider of providers) {
        const snapshot = await options.registry.snapshot(provider)
        snapshots.push(snapshot ?? { provider, queried: false })
      }
      json(res, 200, { snapshots })
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/**
 * Mount the route on an optional webServer context.
 *
 * @param ctx - context whose optional `webServer` serves the route.
 * @param options - registry and route configuration.
 */
export function registerProviderUsageRoute(ctx: Context, options: ProviderUsageRouteOptions): void {
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: options.path ?? PROVIDER_USAGE_PATH,
        handler: providerUsageHandler(options),
      })
      return () => {
        dispose()
      }
    }, 'provider-usage: usage route')
  })
}
