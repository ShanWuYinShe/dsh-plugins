import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkBuddyCatalogStore,
  credentialIdentity,
  type SavedWorkBuddyCatalog,
} from '../src/catalog-store.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function entry(overrides: Partial<SavedWorkBuddyCatalog> = {}): SavedWorkBuddyCatalog {
  return {
    account: 'uid-1:',
    source: 'https://copilot.tencent.com',
    fetchedAtMs: 1_700_000_000_000,
    models: [
      { id: 'm1', name: 'M1', contextWindow: 1000, maxTokens: 100, supportsImages: false },
    ],
    ...overrides,
  }
}

describe('WorkBuddyCatalogStore', () => {
  it('round-trips one account catalog through a fresh instance', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-cstore-'))
    const path = join(root, '.workbuddy-catalog.json')
    const store = new WorkBuddyCatalogStore({ path })
    expect(store.saved('uid-1:')).toBeUndefined()
    await store.save(entry())
    const reopened = new WorkBuddyCatalogStore({ path })
    expect(reopened.saved('uid-1:')).toEqual(entry())
  })

  it('isolates accounts: one account never serves another', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-cstore-'))
    const path = join(root, '.workbuddy-catalog.json')
    const store = new WorkBuddyCatalogStore({ path })
    await store.save(entry({ account: 'uid-1:' }))
    await store.save(entry({ account: 'uid-2:e1', models: [
      { id: 'other', name: 'Other', contextWindow: 2000, maxTokens: 200, supportsImages: true },
    ] }))
    expect(store.saved('uid-1:')?.models.map(m => m.id)).toEqual(['m1'])
    expect(store.saved('uid-2:e1')?.models.map(m => m.id)).toEqual(['other'])
  })

  it('reads malformed, wrong-version, and empty-model files as nothing saved', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-cstore-'))
    const path = join(root, '.workbuddy-catalog.json')
    for (const [name, content] of [
      ['garbage', '{ not json'],
      ['wrong-shape', '{"version":1,"entries":[]}'],
      ['wrong-version', '{"version":999,"entries":{"a":{"account":"a","source":"s","fetchedAtMs":1,"models":[{"id":"m","name":"M","contextWindow":1,"maxTokens":1,"supportsImages":false}]}}}'],
      ['empty-models', '{"version":1,"entries":{"a":{"account":"a","source":"s","fetchedAtMs":1,"models":[]}}}'],
      ['bad-row', '{"version":1,"entries":{"a":{"account":"a","source":"s","fetchedAtMs":1,"models":[{"id":"","name":"M"}]}}}'],
    ] as const) {
      await writeFile(path, content, 'utf8')
      expect(new WorkBuddyCatalogStore({ path }).saved('a'), name).toBeUndefined()
    }
  })

  it('creates missing parent directories on save', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-cstore-'))
    const path = join(root, 'nested', 'deep', '.workbuddy-catalog.json')
    await new WorkBuddyCatalogStore({ path }).save(entry())
    expect(new WorkBuddyCatalogStore({ path }).saved('uid-1:')).toEqual(entry())
  })
})

describe('credentialIdentity', () => {
  it('keys by uid and enterpriseId', () => {
    expect(credentialIdentity({ uid: 'u', enterpriseId: 'e' })).toBe('u:e')
    expect(credentialIdentity({ uid: 'u' })).toBe('u:')
  })
})
