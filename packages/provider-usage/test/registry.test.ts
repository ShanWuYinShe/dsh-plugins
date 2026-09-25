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

  it('keeps the live querier when a replaced registration is disposed', async () => {
    const { registry } = makeRegistry()
    const stale = fixedQuerier([{ id: 'old', label: 'old', remain: 1, unit: 'credits' }])
    const live = fixedQuerier([{ id: 'new', label: 'new', remain: 2, unit: 'credits' }])
    const disposeStale = registry.register('acme', stale)
    registry.register('acme', live)

    // The first registration was replaced before its disposer ran: disposing
    // it must not darken the live querier.
    disposeStale()

    expect(registry.has('acme')).toBe(true)
    expect(registry.providers()).toEqual(['acme'])
    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.windows[0]?.id).toBe('new')
    expect(live).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()
  })

  it('withdraws its own registration on dispose', async () => {
    const { registry } = makeRegistry()
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 1, unit: 'credits' }])
    const dispose = registry.register('acme', querier)
    expect(registry.has('acme')).toBe(true)

    dispose()

    expect(registry.has('acme')).toBe(false)
    expect(registry.providers()).toEqual([])
    expect(await registry.snapshot('acme')).toBeUndefined()
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

  it('times out even when the querier ignores abort and never settles', async () => {
    // 回归:withDeadline 此前只 abort 不 race,querier 是公开扩展点,不理
    // abort 的挂死实现(或挂起的 credentials 服务)会让 inflight 条目永久
    // 残留,该 provider 的每次 snapshot 都返回同一个挂起 Promise——轮询
    // 端点对它永久挂起。deadline 必须靠 race 落地,不依赖对方配合。
    const { registry } = makeRegistry({ timeoutMs: 20 })
    registry.register('acme', async () => new Promise<UsageSnapshot>(() => {}))

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('timed out')

    // 超时后 inflight 条目必须已清理:下一次查询重新发起,而不是复用挂死
    // 的旧 Promise 永久挂起。
    const second = await registry.snapshot('acme')
    expect(second?.error).toContain('timed out')
  })

  it('carries a querier-reported error through the success path', async () => {
    // 回归:软失败契约是「空 windows + error」,转发层此前丢弃 error,浏览器
    // 只能看到「不上报额度」的绿点而非失败原因。
    const { registry } = makeRegistry()
    registry.register('acme', async () => ({
      provider: 'acme',
      windows: [],
      fetchedAt: 0,
      error: 'the balance endpoint reported no usable balance',
    }))

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('no usable balance')
    expect(snapshot?.windows).toEqual([])
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

  it('resolves snapshots via canonical provider aliases', async () => {
    const { registry } = makeRegistry()
    registry.register('moonshot', fixedQuerier([{ id: 'm', label: 'Moonshot', remain: 42, unit: 'cny' }]), 'Moonshot')

    expect(registry.has('kimi')).toBe(true)
    const snapshot = await registry.snapshot('kimi')
    expect(snapshot?.windows).toEqual([{ id: 'm', label: 'Moonshot', remain: 42, unit: 'cny' }])
  })

  it('infers querier from baseURL when custom provider ID is unregistered', async () => {
    const { registry } = makeRegistry()
    registry.setResolver(async () => ({ baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf' }))
    const sfQuerier = vi.fn(async context => ({
      provider: context.provider,
      windows: [{ id: 'sf', label: 'Balance', remain: 99, unit: 'cny' }],
      fetchedAt: 0,
    }))
    registry.register('siliconflow', sfQuerier, 'SiliconFlow')

    // 'my-cloud' is not directly registered and not an alias, but its baseURL is siliconflow.cn
    const snapshot = await registry.snapshot('my-cloud')
    expect(sfQuerier).toHaveBeenCalledTimes(1)
    expect(snapshot?.windows).toEqual([{ id: 'sf', label: 'Balance', remain: 99, unit: 'cny' }])
  })

  it('applies the query deadline to the inference resolve, not just the querier', async () => {
    // 回归:fallback 推断路径此前裸 await resolveProvider,挂死的 resolver
    // (credentials 服务、DeepSeek 账户接口都是真实 I/O)会把 snapshot 永远
    // 挂住——轮询端点没有整体超时,浏览器只能干等。resolve 阶段与 querier
    // 同受 queryTimeoutMs 约束,超时按"无推断结果"处理。
    const { registry } = makeRegistry({ timeoutMs: 20 })
    let aborted = false
    registry.setResolver(async (_provider, signal) => {
      await new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true
          reject(signal.reason ?? new Error('aborted'))
        })
      })
      return { baseURL: 'https://api.siliconflow.cn/v1' }
    })
    const sfQuerier = vi.fn(async (): Promise<UsageSnapshot> => ({ provider: 'siliconflow', windows: [], fetchedAt: 0 }))
    registry.register('siliconflow', sfQuerier)

    const snapshot = await registry.snapshot('my-cloud')
    expect(snapshot).toBeUndefined()
    expect(aborted).toBe(true)
    expect(sfQuerier).not.toHaveBeenCalled()
  })
})

describe('safeMessage', () => {
  it('redacts jwt-shaped and sk-shaped secrets and query parameters', () => {
    const message = safeMessage(new Error('a eyJhbGciOi.eyJzdWIi.sig b sk-0123456789abcdef c ?access_token=zzz'))
    expect(message).not.toContain('eyJhbGciOi')
    expect(message).not.toContain('sk-0123456789abcdef')
    expect(message).toContain('[redacted]')
    expect(message).toContain('access_token=[redacted]')
    expect(message).not.toContain('zzz')
  })

  it('caps a pathological message', () => {
    expect(safeMessage(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(500)
  })
})
