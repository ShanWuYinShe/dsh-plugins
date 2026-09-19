/** Registry behaviour: registration, caching, failure posture, and redaction. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ProviderUsageRegistry, safeMessage } from '../src/registry.js'
import type { UsageSnapshot } from '../src/types.js'

/** Build a registry with a pinned clock so no test ever sleeps. */
function makeRegistry(options: { ttlMs?: number; timeoutMs?: number } = {}) {
  const ctx = new Context()
  let now = 1_000
  const registry = new ProviderUsageRegistry(ctx, {
    cacheTtlMs: options.ttlMs ?? 60_000,
    queryTimeoutMs: options.timeoutMs ?? 15_000,
    now: () => now,
  })
  return { registry, advance: (ms: number) => { now += ms } }
}

/** A querier answering a fixed snapshot. */
function fixedQuerier(windows: { id: string; label: string; remain?: number; unit: string }[], plan?: string) {
  return vi.fn(async (): Promise<UsageSnapshot> => ({
    provider: 'acme',
    ...plan === undefined ? {} : { plan },
    windows,
    fetchedAt: 0,
  }))
}

describe('ProviderUsageRegistry', () => {
  it('answers undefined for a provider with no querier', async () => {
    const { registry } = makeRegistry()
    expect(await registry.snapshot('nobody')).toBeUndefined()
    expect(registry.has('nobody')).toBe(false)
    expect(registry.providers()).toEqual([])
  })

  it('reports registered providers and answers their snapshots', async () => {
    const { registry } = makeRegistry()
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 5, unit: 'credits' }])
    registry.register('acme', querier, 'Acme')

    expect(registry.providers()).toEqual(['acme'])
    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.provider).toBe('acme')
    expect(snapshot?.displayName).toBe('Acme')
    expect(snapshot?.windows).toEqual([{ id: 'a', label: 'A', remain: 5, unit: 'credits' }])
  })

  it('serves a fresh answer from cache and refetches once it expires', async () => {
    const { registry, advance } = makeRegistry({ ttlMs: 100 })
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 5, unit: 'credits' }])
    registry.register('acme', querier)

    await registry.snapshot('acme')
    await registry.snapshot('acme')
    expect(querier).toHaveBeenCalledTimes(1)

    advance(101)
    await registry.snapshot('acme')
    expect(querier).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight query between concurrent readers', async () => {
    const { registry } = makeRegistry()
    let release: (() => void) | undefined
    const querier = vi.fn(async (): Promise<UsageSnapshot> => {
      await new Promise<void>(resolve => { release = resolve })
      return { provider: 'acme', windows: [], fetchedAt: 0 }
    })
    registry.register('acme', querier)

    const first = registry.snapshot('acme')
    const second = registry.snapshot('acme')
    await vi.waitFor(() => { expect(release).toBeDefined() })
    release?.()
    await Promise.all([first, second])
    // Two readers, one billing request: a page polling twice must not double
    // the cost of merely displaying a number.
    expect(querier).toHaveBeenCalledTimes(1)
  })

  it('folds a failed query into the snapshot instead of rejecting', async () => {
    const { registry } = makeRegistry()
    registry.register('acme', async () => { throw new Error('billing endpoint is down') })

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('billing endpoint is down')
    expect(snapshot?.windows).toEqual([])
  })

  it('keeps the last good windows when a refetch fails', async () => {
    const { registry, advance } = makeRegistry({ ttlMs: 100 })
    let fail = false
    registry.register('acme', async () => {
      if (fail) throw new Error('transient')
      return { provider: 'acme', windows: [{ id: 'a', label: 'A', remain: 9, unit: 'credits' }], fetchedAt: 0 }
    })

    await registry.snapshot('acme')
    fail = true
    advance(101)
    const snapshot = await registry.snapshot('acme')
    // A transient outage must not blank the number the user was reading.
    expect(snapshot?.windows).toEqual([{ id: 'a', label: 'A', remain: 9, unit: 'credits' }])
    expect(snapshot?.error).toContain('transient')
  })

  it('redacts the credential a failing endpoint quotes back', async () => {
    const { registry } = makeRegistry({ timeoutMs: 5000 })
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    registry.register('acme', async () => { throw new Error(`rejected key ${secret} for account 42`) })

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).not.toContain(secret)
    expect(snapshot?.error).toContain('[redacted key]')
    expect(snapshot?.error).toContain('account 42')
  })

  it('invalidates one provider or every provider', async () => {
    const { registry } = makeRegistry()
    const acme = fixedQuerier([{ id: 'a', label: 'A', remain: 1, unit: 'credits' }])
    const other = vi.fn(async (): Promise<UsageSnapshot> => ({ provider: 'other', windows: [], fetchedAt: 0 }))
    registry.register('acme', acme)
    registry.register('other', other)

    await registry.snapshot('acme')
    await registry.snapshot('other')
    registry.invalidate('acme')
    await registry.snapshot('acme')
    await registry.snapshot('other')
    expect(acme).toHaveBeenCalledTimes(2)
    expect(other).toHaveBeenCalledTimes(1)

    registry.invalidate()
    await registry.snapshot('other')
    expect(other).toHaveBeenCalledTimes(2)
  })

  it('invalidates the cache when a querier is replaced', async () => {
    const { registry } = makeRegistry()
    const first = fixedQuerier([{ id: 'old', label: 'old', remain: 1, unit: 'credits' }])
    registry.register('acme', first)
    await registry.snapshot('acme')

    // Hot reload re-registers the same provider; the previous answer describes
    // a query that no longer exists.
    registry.register('acme', fixedQuerier([{ id: 'new', label: 'new', remain: 2, unit: 'credits' }]))
    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.windows[0]?.id).toBe('new')
  })

  it('withdraws only its own registration on dispose', async () => {
    const { registry } = makeRegistry()
    registry.register('acme', fixedQuerier([]))
    const disposeStale = registry.register('acme', fixedQuerier([]))
    // A reload replaced the first registration before its disposer ran; the
    // stale disposer must not darken the live querier.
    disposeStale()
    expect(registry.has('acme')).toBe(false)
  })

  it('rejects an empty provider key and a non-function querier', () => {
    const { registry } = makeRegistry()
    expect(() => registry.register('', async () => ({ provider: '', windows: [], fetchedAt: 0 }))).toThrow(TypeError)
    expect(() => registry.register('acme', undefined as never)).toThrow(TypeError)
  })

  it('times out a query that never settles', async () => {
    const { registry } = makeRegistry({ timeoutMs: 20 })
    registry.register('acme', async ({ signal }) => {
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason ?? new Error('aborted')) })
      })
      return { provider: 'acme', windows: [], fetchedAt: 0 }
    })

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('timed out')
  })

  it('passes the resolved endpoint and credential to the querier', async () => {
    const { registry } = makeRegistry()
    const seen: unknown[] = []
    registry.setResolver(async provider => ({ baseURL: `https://${provider}.example`, apiKey: 'k' }))
    registry.register('acme', async context => {
      seen.push({ provider: context.provider, baseURL: context.baseURL, apiKey: context.apiKey })
      return { provider: context.provider, windows: [], fetchedAt: 0 }
    })

    await registry.snapshot('acme')
    expect(seen).toEqual([{ provider: 'acme', baseURL: 'https://acme.example', apiKey: 'k' }])
  })
})

describe('safeMessage', () => {
  it('redacts jwt-shaped and sk-shaped secrets and query parameters', () => {
    const message = safeMessage(new Error('a eyJhbGciOi.eyJzdWIi.sig b sk-0123456789abcdef c ?access_token=zzz'))
    expect(message).not.toContain('eyJhbGciOi')
    expect(message).not.toContain('sk-0123456789abcdef')
    expect(message).toContain('[redacted]')
  })

  it('caps a pathological message', () => {
    expect(safeMessage(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(500)
  })
})
