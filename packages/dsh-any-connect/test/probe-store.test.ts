import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fingerprintModel,
  newestFirst,
  WorkBuddyProbeStore,
  type WorkBuddyProbeRecord,
} from '../src/probe-store.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function record(overrides: Partial<WorkBuddyProbeRecord> = {}): WorkBuddyProbeRecord {
  return {
    probedAtMs: Date.now(),
    fingerprint: 'fp1',
    validation: 'validating',
    efforts: ['low', 'high'],
    pluginVersion: '0.0.0-test',
    account: 'uid-1:',
    ...overrides,
  }
}

function makeStore(ttlMs = 14 * 24 * 3600_000, now = 1_700_000_000_000): { path: string; store: WorkBuddyProbeStore } {
  if (root === undefined) throw new Error('no root')
  const path = join(root, '.workbuddy-probe.json')
  return { path, store: new WorkBuddyProbeStore({ path, ttlMs, pluginVersion: '0.0.0-test', now: () => now }) }
}

describe('WorkBuddyProbeStore', () => {
  it('round-trips one record through a fresh instance', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-pstore-'))
    const { path, store } = makeStore()
    expect(store.get('m', 'fp1', 'uid-1:')).toBeUndefined()
    const saved = record()
    store.set('m', saved)
    const reopened = new WorkBuddyProbeStore({ path, pluginVersion: '0.0.0-test' })
    expect(reopened.get('m', 'fp1', 'uid-1:')).toEqual(saved)
  })

  it('rejects a fingerprint change, another account, and expiry', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-pstore-'))
    const { store } = makeStore()
    store.set('m', record())
    expect(store.get('m', 'other-fp', 'uid-1:')).toBeUndefined()
    expect(store.get('m', 'fp1', 'uid-2:')).toBeUndefined()
    expect(store.get('m', 'fp1', '')).toBeUndefined()
  })

  it('expires records past the TTL', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-pstore-'))
    const early = makeStore(1000, 1_000)
    early.store.set('m', record({ probedAtMs: 1_000 }))
    // Same file, later clock: expired.
    const late = new WorkBuddyProbeStore({ path: early.path, ttlMs: 1000, pluginVersion: 'x', now: () => 1_000 + 1001 })
    expect(late.get('m', 'fp1', 'uid-1:')).toBeUndefined()
  })

  it('keeps a decisive record against a later unknown', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-pstore-'))
    const { store } = makeStore()
    store.set('m', record())
    store.set('m', record({ validation: 'unknown', efforts: [] }))
    expect(store.get('m', 'fp1', 'uid-1:')?.validation).toBe('validating')
  })

  it('clears everything and reads malformed files as empty', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-pstore-'))
    const { path, store } = makeStore()
    store.set('m', record())
    store.clear()
    expect(store.get('m', 'fp1', 'uid-1:')).toBeUndefined()
    await writeFile(path, '{ not json', 'utf8')
    expect(new WorkBuddyProbeStore({ path, pluginVersion: 'x' }).get('m', 'fp1', 'uid-1:')).toBeUndefined()
  })
})

describe('fingerprintModel', () => {
  it('covers id, reasoning, and images — but not display fields', () => {
    const base = { id: 'm', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: true, reasoning: { supports: true, onlyReasoning: true } }
    const renamed = { ...base, name: 'Renamed', billing: { credits: 'x9.99', free: false } }
    expect(fingerprintModel(renamed)).toBe(fingerprintModel(base))
    expect(fingerprintModel({ ...base, id: 'other' })).not.toBe(fingerprintModel(base))
    expect(fingerprintModel({ ...base, reasoning: { supports: false, onlyReasoning: false } })).not.toBe(fingerprintModel(base))
  })
})

describe('newestFirst', () => {
  it('orders observations newest-first', () => {
    expect(newestFirst([{ probedAt: 1 }, { probedAt: 3 }, { probedAt: 2 }]).map(r => r.probedAt)).toEqual([3, 2, 1])
  })
})
