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

  // 2026-10-29 新增：单条恢复是用户的主路径。此前只有 restore()（全量清空），
  // 想放回一两个就得全部恢复、再把其余重新隐藏一遍。
  describe('restoreOne（逐条恢复）', () => {
    it('只恢复指定模型，其余隐藏项保持不动', async () => {
      const store = new ModelFilterStore('test-variant', { path: testFilePath })
      await store.exclude('model-1')
      await store.exclude('model-2')
      await store.exclude('model-3')

      expect(await store.restoreOne('model-2')).toBe(true)
      // 关键断言：另外两个**没有**被一起放回来（这正是旧实现的问题）。
      expect(store.getExcluded()).toEqual(['model-1', 'model-3'])
      expect(store.isExcluded('model-2')).toBe(false)
      expect(store.isExcluded('model-1')).toBe(true)
      expect(store.isExcluded('model-3')).toBe(true)
    })

    it('持久化到磁盘，重新加载后仍只恢复了那一个', async () => {
      const store = new ModelFilterStore('test-variant', { path: testFilePath })
      await store.exclude('model-1')
      await store.exclude('model-2')
      await store.restoreOne('model-1')

      const reloaded = new ModelFilterStore('test-variant', { path: testFilePath })
      expect(reloaded.getExcluded()).toEqual(['model-2'])
    })

    it('恢复本来就没隐藏的模型返回 false 且不改动其它项', async () => {
      const store = new ModelFilterStore('test-variant', { path: testFilePath })
      await store.exclude('model-1')
      expect(await store.restoreOne('never-hidden')).toBe(false)
      expect(store.getExcluded()).toEqual(['model-1'])
    })

    it('空 id 不产生副作用', async () => {
      const store = new ModelFilterStore('test-variant', { path: testFilePath })
      await store.exclude('model-1')
      expect(await store.restoreOne('')).toBe(false)
      expect(await store.restoreOne('   ')).toBe(false)
      expect(store.getExcluded()).toEqual(['model-1'])
    })

    it('restore() 回报被恢复的 id 列表（供调用方说清影响范围）', async () => {
      const store = new ModelFilterStore('test-variant', { path: testFilePath })
      await store.exclude('model-1')
      await store.exclude('model-2')
      expect(await store.restore()).toEqual(['model-1', 'model-2'])
      expect(store.getExcluded()).toEqual([])
    })
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
