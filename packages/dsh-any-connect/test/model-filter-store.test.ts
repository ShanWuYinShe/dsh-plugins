import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ModelFilterStore } from '../src/model-filter-store.js'

describe('ModelFilterStore', () => {
  let testDir: string
  let testFilePath: string

  beforeEach(() => {
    testDir = join(tmpdir(), `mfs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    testFilePath = join(testDir, 'test-excluded-models.json')
  })

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('starts with empty excluded list when file does not exist', () => {
    const store = new ModelFilterStore('test-variant', { path: testFilePath })
    expect(store.getExcluded()).toEqual([])
    expect(store.isExcluded('model-a')).toBe(false)
  })

  it('excludes models and persists them to disk', async () => {
    const store = new ModelFilterStore('test-variant', { path: testFilePath })
    await store.exclude('deepseek-flash')
    await store.exclude('glm-5.1')

    expect(store.getExcluded()).toEqual(['deepseek-flash', 'glm-5.1'])
    expect(store.isExcluded('deepseek-flash')).toBe(true)
    expect(store.isExcluded('glm-5.1')).toBe(true)
    expect(store.isExcluded('other-model')).toBe(false)

    expect(existsSync(testFilePath)).toBe(true)
    const diskContent = JSON.parse(readFileSync(testFilePath, 'utf8'))
    expect(diskContent).toEqual({
      version: 1,
      excluded: ['deepseek-flash', 'glm-5.1'],
    })

    // Reload from disk
    const reloaded = new ModelFilterStore('test-variant', { path: testFilePath })
    expect(reloaded.getExcluded()).toEqual(['deepseek-flash', 'glm-5.1'])
    expect(reloaded.isExcluded('deepseek-flash')).toBe(true)
  })

  it('restores defaults by clearing excluded models and updating disk', async () => {
    const store = new ModelFilterStore('test-variant', { path: testFilePath })
    await store.exclude('model-1')
    await store.exclude('model-2')
    expect(store.getExcluded().length).toBe(2)

    await store.restore()
    expect(store.getExcluded()).toEqual([])
    expect(store.isExcluded('model-1')).toBe(false)

    const reloaded = new ModelFilterStore('test-variant', { path: testFilePath })
    expect(reloaded.getExcluded()).toEqual([])
  })

  it('ignores empty and whitespace-only model IDs', async () => {
    const store = new ModelFilterStore('test-variant', { path: testFilePath })
    await store.exclude('')
    await store.exclude('   ')
    expect(store.getExcluded()).toEqual([])
  })
})
