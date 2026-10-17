import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { migrateLegacyConfig } from '../src/legacy-migrate.js'

/**
 * 旧版 config.json 迁移回归：edit(change) 的语义是"对 Loader 侧当前值做
 * 变换"，迁移必须以 current 为合并基——用 apply 时刻的 patchConfig 快照
 * 为基会覆盖用户在迁移前做的行编辑（丢配置）。
 */

let home: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-sandbox-migrate-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

function legacyCtx(captured: { change?: (current: Record<string, any>) => Record<string, any> }) {
  return {
    fiber: { entry: { id: 'sandbox-extra-roots' } },
    get: (name: string) => {
      if (name !== 'configEditor') throw new Error(`unexpected service ${name}`)
      return {
        edit: async (_entry: unknown, change: (current: Record<string, any>) => Record<string, any>) => {
          captured.change = change
        },
      }
    },
    logger: { warn: () => {} },
  }
}

describe('migrateLegacyConfig', () => {
  it('legacy 合并到 edit 时的 current 上，不丢弃行内已有编辑', async () => {
    const captured: { change?: (current: Record<string, any>) => Record<string, any> } = {}
    const dir = join(home!, 'plugins', 'test-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ extraRoots: ['/legacy'] }))
    await migrateLegacyConfig('test-plugin', legacyCtx(captured) as any)
    expect(captured.change).toBeDefined()
    // 用户在迁移前已把行内改成 other:1：迁移后该编辑必须保留。
    const merged = captured.change!({ extraRoots: ['/user'], other: 1 })
    expect(merged['other']).toBe(1)
    expect(merged['extraRoots']).toEqual(['/legacy'])
  })

  it('无旧文件时不碰 editor', async () => {
    const captured: { change?: (current: Record<string, any>) => Record<string, any> } = {}
    await migrateLegacyConfig('test-plugin', legacyCtx(captured) as any)
    expect(captured.change).toBeUndefined()
  })
})
