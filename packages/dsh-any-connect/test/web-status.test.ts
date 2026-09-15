import { describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.js'
import type { WorkBuddyCredentialStore } from '../src/auth.js'
import type { WorkBuddyModelInfo } from '../src/catalog.js'
import { workBuddyWebStatus } from '../src/web-status.js'
import type { WorkBuddyUpstreamClient } from '../src/upstream.js'

/**
 * Offline unit tests for the status document the plugin card renders: the
 * model-offer selection (free / promo rows) and the rate suppression for
 * models whose 免费 chip already says it all.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 1234,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

function storeWith(credential: WorkBuddyCredential | undefined): WorkBuddyCredentialStore {
  return {
    status: async () => credential === undefined
      ? { state: 'signed-out' }
      : { state: 'signed-in', expiresAtMs: credential.expiresAtMs, nickname: 'tester', source: credential.source },
    current: async () => credential,
  } as unknown as WorkBuddyCredentialStore
}

function clientWith(result: Promise<unknown>): Pick<WorkBuddyUpstreamClient, 'fetchCredits'> {
  return { fetchCredits: () => result } as Pick<WorkBuddyUpstreamClient, 'fetchCredits'>
}

function model(overrides: Partial<WorkBuddyModelInfo>): WorkBuddyModelInfo {
  return {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    billing: { free: false },
    ...overrides,
  } as WorkBuddyModelInfo
}

describe('workBuddyWebStatus', () => {
  it('returns a bare signed-out document without touching credits', async () => {
    const fetchCredits = vi.fn()
    const status = await workBuddyWebStatus({
      store: storeWith(undefined),
      client: { fetchCredits } as unknown as Pick<WorkBuddyUpstreamClient, 'fetchCredits'>,
      models: () => [],
      catalog: () => ({ source: 'fallback' }),
      probe: () => ({ consent: false, running: false, candidates: [], results: [] }),
      probeKey: 'test-key',
    })
    expect(status).toEqual({ status: 'signed-out' })
    expect(fetchCredits).not.toHaveBeenCalled()
  })

  it('keeps the multiplier on a promo model and suppresses it on a free one', async () => {
    const status = await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      client: clientWith(Promise.resolve({ total: 43, accounts: [] })),
      models: () => [
        model({ id: 'promo', name: 'Promo', billing: { credits: 'x0.79 credits', badges: ['夜间折扣'], free: false } }),
        model({ id: 'free', name: 'Free', billing: { credits: 'x0.00', badges: ['限时免费'], free: true } }),
      ],
      catalog: () => ({ source: 'live', fetchedAt: 1700000000000 }),
      probe: () => ({ consent: true, running: false, candidates: ['m'], results: [] }),
      probeKey: 'test-key',
    })
    expect(status.status).toBe('signed-in')
    expect(status.models).toEqual([
      { id: 'promo', name: 'Promo', badges: ['夜间折扣'], credits: 'x0.79' },
      { id: 'free', name: 'Free', badges: ['限时免费'], free: true },
    ])
  })

  it('omits the models field when no model is free or badged', async () => {
    const status = await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      client: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [model({ id: 'plain', name: 'Plain', billing: { credits: 'x1.62', free: false } })],
      catalog: () => ({ source: 'saved', fetchedAt: 1700000000000 }),
      probe: () => ({ consent: false, running: false, candidates: [], results: [] }),
      probeKey: 'test-key',
    })
    expect(status.models).toBeUndefined()
    expect(status.credits).toEqual({ total: 1, accounts: [] })
  })

  it('carries the catalog source, fetch time, and last error through', async () => {
    const live = await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      client: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [],
      catalog: () => ({ source: 'live', fetchedAt: 1700000000000 }),
      probe: () => ({ consent: true, running: true, candidates: ['m'], results: [] }),
      probeKey: 'test-key',
    })
    expect(live.catalog).toEqual({ source: 'live', fetchedAt: 1700000000000 })
    expect(live.probe).toEqual({ consent: true, running: true, candidates: ['m'], results: [] })
    expect(live.probeKey).toBe('test-key')
    const failed = await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      client: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [],
      catalog: () => ({ source: 'saved', fetchedAt: 1699999999999, error: 'upstream down' }),
      probe: () => ({ consent: false, running: false, candidates: [], results: [] }),
      probeKey: 'test-key',
    })
    expect(failed.catalog).toEqual({ source: 'saved', fetchedAt: 1699999999999, error: 'upstream down' })
  })

  it('degrades a credits failure to creditsError and keeps the model facts', async () => {
    const status = await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      client: clientWith(Promise.reject(new Error('boom'))),
      models: () => [model({ id: 'free', name: 'Free', billing: { credits: 'x0.00', free: true } })],
      catalog: () => ({ source: 'fallback', error: 'boom' }),
      probe: () => ({ consent: false, running: false, candidates: [], results: [] }),
      probeKey: 'test-key',
    })
    expect(status.creditsError).toBe('boom')
    expect(status.models).toEqual([{ id: 'free', name: 'Free', free: true }])
  })
})
