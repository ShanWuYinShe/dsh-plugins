import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConfigStore } from '../src/config-store.js'

/**
 * 配置持久化的直接测试。
 *
 * 本文件与 session-archive/src/config-store.ts **逐字一致**（由 bundle 锁钉住），
 * 所以这里钉住的行为对两份都生效——两侧不可能漂移。
 *
 * 覆盖：生效顺序（defaults < patch < json）、原子写入（0600 + 无 tmp 残留）、
 * 损坏 JSON 只告警一次并兜底、onUpdate 热更新与失败告警、validate 在写盘前拦截。
 *
 * 隔离：createConfigStore 在**调用时**读 process.env.DSH_HOME，
 * 每个用例用 vi.stubEnv 指向独立临时目录，互不影响、也不碰真实 ~/.dsh。
 */

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'config-store-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function makeStore(overrides: Partial<Parameters<typeof createConfigStore>[0]> = {}) {
  return createConfigStore({
    name: 'test-plugin',
    defaults: { theme: 'light', retries: 3 },
    patchConfig: { theme: 'dark' },
    ...overrides,
  })
}

describe('生效顺序', () => {
  it('defaults < patchConfig < config.json（后者覆盖前者）', () => {
    const store = makeStore()
    expect(store.effective()).toEqual({ theme: 'dark', retries: 3 })
    const file = store.file
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ theme: 'auto', extra: true }))
    expect(store.effective()).toEqual({ theme: 'auto', retries: 3, extra: true })
  })

  it('config.json 不存在时 effective 只有 defaults+patch', () => {
    const store = makeStore()
    expect(store.effective()).toEqual({ theme: 'dark', retries: 3 })
    expect(existsSync(store.file)).toBe(false)
  })
})

describe('set', () => {
  it('合并写入并返回新的生效配置，文件真实落盘', () => {
    const store = makeStore()
    const next = store.set({ theme: 'auto' })
    expect(next).toEqual({ theme: 'auto', retries: 3 })
    const onDisk = JSON.parse(readFileSync(store.file, 'utf8'))
    expect(onDisk).toEqual({ theme: 'auto' })
  })

  it('跨多次 set 保留此前写入的键', () => {
    const store = makeStore()
    store.set({ a: 1 })
    store.set({ b: 2 })
    expect(JSON.parse(readFileSync(store.file, 'utf8'))).toEqual({ a: 1, b: 2 })
  })

  it('非对象（数组/null/字符串）抛 TypeError', () => {
    const store = makeStore()
    for (const bad of [[], null, 'x', 42]) {
      expect(() => store.set(bad as never), JSON.stringify(bad)).toThrow(TypeError)
    }
    expect(existsSync(store.file)).toBe(false)
  })

  it('validate 在写盘前调用；抛错则什么都不写', () => {
    const validate = vi.fn(() => { throw new Error('bad key') })
    const store = makeStore({ validate })
    expect(() => store.set({ theme: 'nope' })).toThrow('bad key')
    expect(validate).toHaveBeenCalledTimes(1)
    expect(existsSync(store.file)).toBe(false)
  })

  it('onUpdate 收到 (merged, next)；抛错只告警、配置仍已保存', () => {
    const onUpdate = vi.fn(() => { throw new Error('callback exploded') })
    const warn = vi.fn()
    const store = makeStore({ onUpdate, warn })
    const next = store.set({ theme: 'auto' })
    expect(onUpdate).toHaveBeenCalledWith({ theme: 'auto' }, next)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/onUpdate failed.*callback exploded/))
    expect(JSON.parse(readFileSync(store.file, 'utf8'))).toEqual({ theme: 'auto' })
  })

  it('写入后无 .tmp 残留（原子 rename）', () => {
    const store = makeStore()
    store.set({ theme: 'auto' })
    const dir = join(store.file, '..')
    const leftovers = readdirSync(dir).filter((n: string) => n.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('文件权限 0600', () => {
    const store = makeStore()
    store.set({ theme: 'auto' })
    const mode = statSync(store.file).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('损坏配置兜底', () => {
  it('坏 JSON 只告警一次并按空配置处理', () => {
    const store = makeStore()
    mkdirSync(join(store.file, '..'), { recursive: true })
    writeFileSync(store.file, '{not json')
    const warn = vi.fn()
    const warnedStore = makeStore({ warn })
    expect(warnedStore.effective()).toEqual({ theme: 'dark', retries: 3 })
    expect(warn).toHaveBeenCalledTimes(1)
    // 第二次读不再重复告警（readWarningShown 闸门）。
    warnedStore.effective()
    expect(warn).toHaveBeenCalledTimes(1)
    void store
  })

  it('JSON 是数组（非对象）同样告警兜底', () => {
    const store = makeStore()
    mkdirSync(join(store.file, '..'), { recursive: true })
    writeFileSync(store.file, '[1,2,3]')
    const warn = vi.fn()
    const warnedStore = makeStore({ warn })
    expect(warnedStore.effective()).toEqual({ theme: 'dark', retries: 3 })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/must contain a JSON object/))
  })
})
