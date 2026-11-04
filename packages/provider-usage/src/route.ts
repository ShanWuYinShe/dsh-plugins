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
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import { safeMessage } from './registry.js'
import type { ProviderUsageRegistry } from './registry.js'
import { PROVIDER_USAGE_PATH, type ProviderUsageAnswer, type ProviderUsageResponse } from './types.js'

/** Constructor dependencies. */
interface ProviderUsageRouteOptions {
  registry: ProviderUsageRegistry
  /** Route path; defaults to the shared constant. */
  path?: string
  /** Upper bound on the provider list one request may ask for. */
  maxProviders?: number
  /** 一次请求顺序查全部 provider 的**总预算**（毫秒）；默认 {@link DEFAULT_REQUEST_BUDGET_MS}。 */
  budgetMs?: number
}

/** Largest provider list one request may name. */
const DEFAULT_MAX_PROVIDERS = 20

/**
 * 一次 usage 请求的总预算（毫秒）。
 *
 * route 顺序查最多 {@link DEFAULT_MAX_PROVIDERS} 个 provider，每个又受 15s
 * 单查询 deadline 约束——没有总预算时单请求最坏可挂约 5 分钟（浏览器早已超时，
 * 服务端还在排队打账单接口）。20s 覆盖正常一轮「首帧查询」并给出上界：超时后
 * 在途读取折叠成失败快照，响应仍然完整（逐 provider 都能读到错误）。
 */
const DEFAULT_REQUEST_BUDGET_MS = 20_000

// 错误文本统一走 registry 导出的 safeMessage：本地曾有一份少一条
// “token=/api_key= 查询参数”脱敏规则的旧副本，与 registry 版本漂移——
// 同包内没有跨包独立发布的理由，必须单一来源。

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * Loopback guards. IP 字面量的判定委托宿主 `isLoopbackHost`（127/8 全段、
 * ::1 及 IPv4-mapped 形态）；`localhost` 主机名宿主不认（非 IP 字面量），
 * 在此显式允许。空串 Origin 按「分化时偏向拒绝」处理（见单测）。
 *
 * Usage is account-level information: a request without an origin is a
 * same-origin fetch from the served page (browsers omit it on some GETs),
 * and any other origin is a cross-site read attempt. The Host check
 * additionally drops DNS-rebinding navigation/form requests, which carry
 * no Origin but send the attacker's domain in Host.
 */
function unwrapBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** 环回主机名：localhost 或宿主认定的环回 IP 字面量。 */
function isLoopbackName(hostname: string): boolean {
  return hostname === 'localhost' || isLoopbackHost(unwrapBrackets(hostname))
}

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
  return isLoopbackName(hostnameOfHost(host))
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const { hostname } = new URL(origin)
    return isLoopbackName(hostname)
  } catch {
    return false
  }
}

/** `refresh=1|true` 表示绕过缓存读:面板手动刷新用,自动轮询不带。 */
function forceRequested(url: URL): boolean {
  const value = url.searchParams.get('refresh')
  return value === '1' || value === 'true'
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
  const budgetMs = options.budgetMs ?? DEFAULT_REQUEST_BUDGET_MS
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
      const force = forceRequested(url)
      // 总预算：一次请求内所有顺序查询共享同一个 deadline 信号。到点后
      // registry 把在途读取折叠成失败快照，循环继续把剩余 provider 以
      // 「预算耗尽」失败行补齐，响应仍是完整的世界，而不是半截 JSON。
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort(new Error(`usage request exceeded its ${budgetMs}ms budget`))
      }, budgetMs)
      timer.unref?.()
      try {
        // Sequential rather than parallel: these are billing endpoints, and
        // firing twenty at once from one page poll is how an account gets
        // rate-limited for merely displaying a number.
        const snapshots: ProviderUsageAnswer[] = []
        for (const provider of providers) {
          const snapshot = await options.registry.snapshot(provider, { force, signal: controller.signal })
          snapshots.push(snapshot ?? { provider, queried: false })
        }
        // cacheTtlMs 随响应交给浏览器：client 的轮询要排在宿主缓存过期之后，
        // 否则两边各写一个 60s 常量会撞相位（命中未过期缓存 → 实际更新间隔翻倍）。
        const body: ProviderUsageResponse = { snapshots, cacheTtlMs: options.registry.cacheTtlMs }
        json(res, 200, body)
      } finally {
        clearTimeout(timer)
      }
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
    // register() 返回的就是幂等反注册器，直接作为 effect 的 disposer。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: options.path ?? PROVIDER_USAGE_PATH,
      handler: providerUsageHandler(options),
    }), 'provider-usage: usage route')
  })
}
