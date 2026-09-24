/** Route behaviour: loopback guards (Host + Origin), method guard, request parsing, and answers. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ProviderUsageRegistry } from '../src/registry.js'
import { providerUsageHandler } from '../src/route.js'
import type { UsageSnapshot } from '../src/types.js'

/** Build a registry with one answering provider. */
function makeRegistry(): ProviderUsageRegistry {
  const registry = new ProviderUsageRegistry(new Context(), { cacheTtlMs: 0 })
  registry.register('acme', async (): Promise<UsageSnapshot> => ({
    provider: 'acme',
    windows: [{ id: 'w', label: 'W', remain: 3, unit: 'credits' }],
    fetchedAt: 7,
  }), 'Acme')
  return registry
}

/** Minimal request/response doubles capturing what the handler wrote. */
function fakeExchange(options: { method?: string; url?: string; origin?: string; host?: string | null } = {}) {
  const headers: Record<string, string> = {}
  // 真实浏览器同源请求恒带 Host：默认补环回 Host，只在显式测缺席时传 null。
  if (options.host === undefined) headers['host'] = '127.0.0.1'
  else if (options.host !== null) headers['host'] = options.host
  if (options.origin !== undefined) headers['origin'] = options.origin
  const req = { method: options.method ?? 'GET', url: options.url ?? '/', headers } as unknown as IncomingMessage
  let status = 0
  let body = ''
  const res = {
    writeHead: (code: number) => { status = code; return res },
    end: (chunk?: string) => { body = chunk ?? '' },
  } as unknown as ServerResponse
  return { req, res, result: () => ({ status, body: JSON.parse(body) as unknown }) }
}

describe('providerUsageHandler', () => {
  it('answers the requested providers in order', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ url: '/?providers=acme,missing' })
    await handler(exchange.req, exchange.res)

    const { status, body } = exchange.result()
    expect(status).toBe(200)
    expect(body).toEqual({ snapshots: [
      { provider: 'acme', displayName: 'Acme', windows: [{ id: 'w', label: 'W', remain: 3, unit: 'credits' }], fetchedAt: expect.any(Number) },
      // A provider with no querier is a normal answer, not a 404: the surface
      // must be able to tell "nobody can answer" from "route missing".
      { provider: 'missing', queried: false },
    ] })
  })

  it('answers an empty list when no provider is requested', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ url: '/' })
    await handler(exchange.req, exchange.res)
    expect(exchange.result()).toEqual({ status: 200, body: { snapshots: [] } })
  })

  it('deduplicates repeated providers and ignores blank segments', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ url: '/?providers=acme, acme ,,acme' })
    await handler(exchange.req, exchange.res)
    const { body } = exchange.result() as { body: { snapshots: unknown[] } }
    expect(body.snapshots).toHaveLength(1)
  })

  it('caps how many providers one request may ask for', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry(), maxProviders: 2 })
    const exchange = fakeExchange({ url: '/?providers=a,b,c,d' })
    await handler(exchange.req, exchange.res)
    const { body } = exchange.result() as { body: { snapshots: unknown[] } }
    expect(body.snapshots).toHaveLength(2)
  })

  it('refuses a non-GET method', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ method: 'POST', url: '/?providers=acme' })
    await handler(exchange.req, exchange.res)
    expect(exchange.result()).toEqual({ status: 405, body: { error: 'method not allowed' } })
  })

  it('refuses a cross-site origin', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ url: '/?providers=acme', origin: 'https://evil.example' })
    await handler(exchange.req, exchange.res)
    expect(exchange.result()).toEqual({ status: 403, body: { error: 'request-not-trusted' } })
  })

  it('refuses a missing Host header (DNS-rebinding navigation carries no Origin)', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ url: '/?providers=acme', host: null })
    await handler(exchange.req, exchange.res)
    expect(exchange.result()).toEqual({ status: 403, body: { error: 'request-not-trusted' } })
  })

  it('refuses an attacker-domain Host header (DNS rebinding)', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ url: '/?providers=acme', host: 'evil.example' })
    await handler(exchange.req, exchange.res)
    expect(exchange.result()).toEqual({ status: 403, body: { error: 'request-not-trusted' } })
  })

  it.each(['127.0.0.1:3080', 'localhost:3080', '[::1]:3080'])(
    'accepts the loopback Host %s',
    async host => {
      const handler = providerUsageHandler({ registry: makeRegistry() })
      const exchange = fakeExchange({ url: '/?providers=acme', host })
      await handler(exchange.req, exchange.res)
      expect(exchange.result().status).toBe(200)
    },
  )

  it.each(['http://localhost:3080', 'http://127.0.0.1:3080', 'http://[::1]:3080'])(
    'accepts the loopback origin %s',
    async origin => {
      const handler = providerUsageHandler({ registry: makeRegistry() })
      const exchange = fakeExchange({ url: '/?providers=acme', origin })
      await handler(exchange.req, exchange.res)
      expect(exchange.result().status).toBe(200)
    },
  )

  it('never leaks a token embedded in a failure', async () => {
    const registry = new ProviderUsageRegistry(new Context(), { cacheTtlMs: 0 })
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    registry.register('acme', async () => { throw new Error(`bad key ${secret}`) })
    const handler = providerUsageHandler({ registry })
    const exchange = fakeExchange({ url: '/?providers=acme' })
    await handler(exchange.req, exchange.res)

    const { body } = exchange.result() as { body: { snapshots: { error?: string }[] } }
    expect(body.snapshots[0]?.error).toContain('[redacted key]')
    expect(body.snapshots[0]?.error).not.toContain(secret)
  })

  it('answers 500 with a redacted reason when the registry itself throws', async () => {
    const registry = makeRegistry()
    vi.spyOn(registry, 'snapshot').mockRejectedValue(new Error('boom sk-0123456789abcdef'))
    const handler = providerUsageHandler({ registry })
    const exchange = fakeExchange({ url: '/?providers=acme' })
    await handler(exchange.req, exchange.res)

    const { status, body } = exchange.result() as { status: number; body: { error: string } }
    expect(status).toBe(500)
    expect(body.error).not.toContain('sk-0123456789abcdef')
  })
})
