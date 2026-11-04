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

  /** 请求总预算信号：每次读取都带同一个 AbortSignal（一次请求共享预算）。 */
  function budgetSignalOf(spy: ReturnType<typeof vi.spyOn>): AbortSignal | undefined {
    const options = spy.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined
    return options?.signal
  }

  it('refresh=1 以 force 透传 registry（手动刷新穿透宿主缓存）', async () => {
    const registry = makeRegistry()
    const spy = vi.spyOn(registry, 'snapshot').mockResolvedValue(undefined)
    const handler = providerUsageHandler({ registry })
    const exchange = fakeExchange({ url: '/?providers=acme&refresh=1' })
    await handler(exchange.req, exchange.res)
    expect(spy).toHaveBeenCalledWith('acme', expect.objectContaining({ force: true }))
    expect(budgetSignalOf(spy)).toBeInstanceOf(AbortSignal)
  })

  it('不带 refresh 参数时不开 force（自动轮询保持走缓存）', async () => {
    const registry = makeRegistry()
    const spy = vi.spyOn(registry, 'snapshot').mockResolvedValue(undefined)
    const handler = providerUsageHandler({ registry })
    const exchange = fakeExchange({ url: '/?providers=acme' })
    await handler(exchange.req, exchange.res)
    expect(spy).toHaveBeenCalledWith('acme', expect.objectContaining({ force: false }))
  })

  it('refresh 取值 1/true 之外不生效', async () => {
    const registry = makeRegistry()
    const spy = vi.spyOn(registry, 'snapshot').mockResolvedValue(undefined)
    const handler = providerUsageHandler({ registry })
    const exchange = fakeExchange({ url: '/?providers=acme&refresh=yes' })
    await handler(exchange.req, exchange.res)
    expect(spy).toHaveBeenCalledWith('acme', expect.objectContaining({ force: false }))
  })

  it('总预算到点时取消在途读取并仍返回完整响应（不悬挂整个请求）', async () => {
    vi.useFakeTimers()
    try {
      const seen: AbortSignal[] = []
      // 复刻真实 registry 的失败姿态：取消折叠成带 error 的失败快照（不 reject），
      // 已取消的信号在入口直接结算（不等下一次 abort 事件）。
      const registry = {
        snapshot: vi.fn((provider: string, options: { signal?: AbortSignal }) => new Promise(resolve => {
          const signal = options.signal
          if (signal === undefined) return
          if (signal.aborted) {
            resolve({ provider, windows: [], fetchedAt: 0, error: String(signal.reason) })
            return
          }
          seen.push(signal)
          signal.addEventListener('abort', () => resolve({ provider, windows: [], fetchedAt: 0, error: String(signal.reason) }), { once: true })
        })),
      } as never
      const handler = providerUsageHandler({ registry, budgetMs: 5 })
      const exchange = fakeExchange({ url: '/?providers=a,b' })
      const pending = handler(exchange.req, exchange.res)
      await vi.advanceTimersByTimeAsync(5)
      await pending
      // 请求在预算时刻完整结算：两个 provider 都有失败行，没有悬挂。
      const { status, body } = exchange.result() as { status: number; body: { snapshots: { error?: string }[] } }
      expect(status).toBe(200)
      expect(body.snapshots).toHaveLength(2)
      expect(body.snapshots.every(snapshot => snapshot.error?.includes('budget') === true)).toBe(true)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every(signal => signal.aborted)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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

  it.each(['127.0.0.1:3080', '127.0.0.2:3080', 'localhost:3080', '[::1]:3080'])(
    'accepts the loopback Host %s',
    async host => {
      const handler = providerUsageHandler({ registry: makeRegistry() })
      const exchange = fakeExchange({ url: '/?providers=acme', host })
      await handler(exchange.req, exchange.res)
      expect(exchange.result().status).toBe(200)
    },
  )

  it.each(['http://localhost:3080', 'http://127.0.0.1:3080', 'http://127.0.0.2:3080', 'http://[::1]:3080'])(
    'accepts the loopback origin %s',
    async origin => {
      const handler = providerUsageHandler({ registry: makeRegistry() })
      const exchange = fakeExchange({ url: '/?providers=acme', origin })
      await handler(exchange.req, exchange.res)
      expect(exchange.result().status).toBe(200)
    },
  )

  it('refuses an empty-string Origin（分化点：any-connect 放行，本包偏向拒绝）', async () => {
    const handler = providerUsageHandler({ registry: makeRegistry() })
    const exchange = fakeExchange({ url: '/?providers=acme', origin: '' })
    await handler(exchange.req, exchange.res)
    expect(exchange.result()).toEqual({ status: 403, body: { error: 'request-not-trusted' } })
  })

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
    // registry.safeMessage 的完整规则集(含查询参数脱敏)必须在 500 路径生效:
    // route 曾有少一条 token= 参数规则的本地副本,漂移即由此锁定。
    vi.spyOn(registry, 'snapshot')
      .mockRejectedValue(new Error('boom sk-0123456789abcdef ?refresh_token=zzz-secret'))
    const handler = providerUsageHandler({ registry })
    const exchange = fakeExchange({ url: '/?providers=acme' })
    await handler(exchange.req, exchange.res)

    const { status, body } = exchange.result() as { status: number; body: { error: string } }
    expect(status).toBe(500)
    expect(body.error).not.toContain('sk-0123456789abcdef')
    expect(body.error).not.toContain('zzz-secret')
    expect(body.error).toContain('refresh_token=[redacted]')
  })
})
