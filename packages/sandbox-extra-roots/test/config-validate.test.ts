/**
 * 额外可写根的配置校验与目录过滤测试。
 *
 * 2026-10-08 补：这两个模块是 apply.ts 拆出的「门禁」——一个决定配置能否写进去，
 * 一个决定哪些根会真的授予给沙盒。它们此前没有任何直接测试，而门禁代码恰恰是
 * 「改错了不会立刻报错」的那类（多授予一个危险根 = 静默放开沙盒边界）。
 *
 * 平台无关：断言只依赖运行时取值（tmpdir()/homedir()）与跨平台常量（"/"、"/etc"）。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeRoots, validateSandboxConfig } from '../src/config-validate.js'
import { clearDirExistCache, existingDirectoryRoots, isExistingDirCached } from '../src/roots-filter.js'

const made: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ser-gate-'))
  made.push(dir)
  return dir
}

afterEach(() => {
  clearDirExistCache()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('validateSandboxConfig', () => {
  it('拒绝非普通对象', () => {
    for (const bad of [null, undefined, 42, 'x', []]) {
      expect(() => validateSandboxConfig(bad)).toThrow(TypeError)
    }
  })

  it('拒绝非数组的 extraWritableRoots', () => {
    expect(() => validateSandboxConfig({ extraWritableRoots: 'not-an-array' })).toThrow(/must be an array/)
  })

  it('拒绝相对路径、空串与非字符串', () => {
    for (const bad of ['relative/dir', '', 7, null]) {
      expect(() => validateSandboxConfig({ extraWritableRoots: [bad] })).toThrow(/absolute/)
    }
  })

  it('拒绝危险根：文件系统根与用户主目录', () => {
    expect(() => validateSandboxConfig({ extraWritableRoots: ['/'] })).toThrow(/dangerous/)
    expect(() => validateSandboxConfig({ extraWritableRoots: [homedir()] })).toThrow(/dangerous/)
  })

  it('接受正常绝对路径，也接受 ~ 拼写（先展开再判定）', () => {
    expect(() => validateSandboxConfig({ extraWritableRoots: [tempDir()] })).not.toThrow()
    expect(() => validateSandboxConfig({ extraWritableRoots: ['~/some-subdir'] })).not.toThrow()
  })
})

describe('normalizeRoots', () => {
  it('extraWritableRoots 不是数组时告警并返回空', () => {
    const warnings: string[] = []
    expect(normalizeRoots({ extraWritableRoots: 'nope' }, (m) => warnings.push(m))).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('must be an array')
  })

  it('展开 ~、剔除相对路径、去重', () => {
    const warnings: string[] = []
    const dir = tempDir()
    const roots = normalizeRoots({ extraWritableRoots: [dir, dir, 'relative/dir', '~'] }, (m) => warnings.push(m))
    // '~' 展开成主目录本身 → 属危险根（reject），会被剔除；相对路径同样剔除。
    expect(roots).toHaveLength(1)
    expect(roots[0]).toContain(dir.split('/').pop() ?? '')
    expect(warnings.some((m) => m.includes('non-absolute'))).toBe(true)
    expect(warnings.some((m) => m.includes('dangerous'))).toBe(true)
  })

  it('剔除系统目录（filter 级）', () => {
    const warnings: string[] = []
    const roots = normalizeRoots({ extraWritableRoots: ['/etc', tempDir()] }, (m) => warnings.push(m))
    expect(roots).toHaveLength(1)
    expect(warnings.some((m) => m.includes('system directory'))).toBe(true)
  })
})

describe('existingDirectoryRoots', () => {
  it('只保留真实存在的目录', () => {
    const warnings: string[] = []
    const dir = tempDir()
    const missing = join(dir, 'not-created')
    const kept = existingDirectoryRoots([dir, missing], new Set<string>(), 'test', (m) => warnings.push(m))
    expect(kept).toEqual([dir])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('does not exist')
  })

  it('同一侧同一根只告警一次（warned 复用）', () => {
    const warnings: string[] = []
    const warned = new Set<string>()
    const missing = join(tempDir(), 'nope')
    existingDirectoryRoots([missing], warned, 'test', (m) => warnings.push(m))
    existingDirectoryRoots([missing], warned, 'test', (m) => warnings.push(m))
    expect(warnings).toHaveLength(1)
  })

  it('clearDirExistCache 后按当前文件系统立即判定（不沿用旧 TTL）', () => {
    const dir = tempDir()
    const late = join(dir, 'late')
    expect(isExistingDirCached(late)).toBe(false)
    mkdirSync(late)
    expect(isExistingDirCached(late)).toBe(false) // 仍在 TTL 内，沿用旧结论
    clearDirExistCache()
    expect(isExistingDirCached(late)).toBe(true)
  })
})
