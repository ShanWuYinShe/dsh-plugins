import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { legacyConfigPath, markLegacyImported, readLegacyConfig, resolveConfigPersist } from '../src/config-store.js'

/**
 * 配置持久化适配的直接测试。
 *
 * 本文件与 session-archive/src/config-store.ts **逐字一致**（由 bundle 锁钉住），
 * 所以这里钉住的行为对两份都生效——两侧不可能漂移。
 *
 * 覆盖：官方 configEditor 通道解析（resolveConfigPersist 的可用与降级）、
 * 旧版 config.json 的读取与改名迁移（readLegacyConfig / markLegacyImported）。
 * 持久化本体（profile patch 的原子写与对账）由官方 dsh-config-editor 负责，
 * 不在本文件测试面内。
 *
 * 隔离：legacyConfigPath 在**调用时**读 process.env.DSH_HOME，
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

function writeLegacyConfig(body: string) {
  const file = legacyConfigPath('test-plugin')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
  return file
}

describe('legacyConfigPath', () => {
  it('落在 $DSH_HOME/plugins/<name>/config.json', () => {
    expect(legacyConfigPath('test-plugin')).toBe(join(home, 'plugins', 'test-plugin', 'config.json'))
  })

  it('DSH_HOME 为空白时回退 ~/.dsh（不 stub，仅断言形状）', () => {
    vi.stubEnv('DSH_HOME', '   ')
    const p = legacyConfigPath('x')
    expect(p).toContain('plugins')
    expect(p.endsWith(join('x', 'config.json'))).toBe(true)
  })
})

describe('readLegacyConfig', () => {
  it('文件不存在返回 undefined', () => {
    expect(readLegacyConfig('test-plugin')).toBeUndefined()
  })

  it('JSON 对象正常读出', () => {
    writeLegacyConfig(JSON.stringify({ theme: 'auto', extra: true }))
    expect(readLegacyConfig('test-plugin')).toEqual({ theme: 'auto', extra: true })
  })

  it('坏 JSON 返回 undefined（迁移跳过，文件保留原样）', () => {
    const file = writeLegacyConfig('{not json')
    expect(readLegacyConfig('test-plugin')).toBeUndefined()
    expect(existsSync(file)).toBe(true)
  })

  it('JSON 数组（非对象）同样返回 undefined', () => {
    writeLegacyConfig('[1,2,3]')
    expect(readLegacyConfig('test-plugin')).toBeUndefined()
  })
})

describe('markLegacyImported', () => {
  it('把旧文件改名 *.imported，内容原样保留', () => {
    const file = writeLegacyConfig(JSON.stringify({ theme: 'auto' }))
    markLegacyImported('test-plugin')
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(`${file}.imported`, 'utf8')).toBe(JSON.stringify({ theme: 'auto' }))
  })

  it('文件已不存在时静默无操作', () => {
    expect(() => markLegacyImported('test-plugin')).not.toThrow()
  })

  it('已存在 *.imported 时再次迁移覆盖之（rename 语义），不抛错', () => {
    const file = writeLegacyConfig('{"v":1}')
    renameSync(file, `${file}.imported`)
    writeLegacyConfig('{"v":2}')
    expect(() => markLegacyImported('test-plugin')).not.toThrow()
    expect(readFileSync(`${file}.imported`, 'utf8')).toBe('{"v":2}')
  })
})

describe('resolveConfigPersist', () => {
  function makeCtx({ entry, editor, getThrows }: { entry?: unknown; editor?: unknown; getThrows?: boolean }) {
    return {
      fiber: entry === undefined ? undefined : { entry },
      get: (name: string) => {
        if (getThrows) throw new Error('service missing')
        if (name === 'configEditor') return editor
        return undefined
      },
    }
  }

  it('entry 与 config-editor 都在时，edit 透传给 editor.edit(entry, change)', async () => {
    const entry = { options: { id: 'test' } }
    const edit = vi.fn(async (_e: unknown, _change: unknown) => {})
    const persist = resolveConfigPersist(makeCtx({ entry, editor: { edit } }))
    expect(persist).toBeDefined()
    const change = () => ({ a: 1 })
    await persist!.edit(change)
    expect(edit).toHaveBeenCalledWith(entry, change)
  })

  it('无 fiber entry（非 profile 部署）返回 undefined', () => {
    expect(resolveConfigPersist(makeCtx({}))).toBeUndefined()
  })

  it('config-editor 服务缺失返回 undefined', () => {
    const entry = { options: { id: 'test' } }
    expect(resolveConfigPersist(makeCtx({ entry, editor: undefined }))).toBeUndefined()
  })

  it('ctx.get 抛错（宿主服务解析失败）返回 undefined 而非外泄异常', () => {
    const entry = { options: { id: 'test' } }
    expect(resolveConfigPersist(makeCtx({ entry, getThrows: true }))).toBeUndefined()
  })

  it('editor.edit 的拒绝原样向上传播（由调用方决定失败姿态）', async () => {
    const entry = { options: { id: 'test' } }
    const edit = vi.fn(async () => { throw new Error('reconciliation failed') })
    const persist = resolveConfigPersist(makeCtx({ entry, editor: { edit } }))!
    await expect(persist.edit(() => ({}))).rejects.toThrow('reconciliation failed')
  })
})
