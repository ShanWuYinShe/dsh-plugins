import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { migrateLegacyConfig } from '../src/legacy-migrate.js'

/**
 * 旧版 config.json 迁移回归（与 sandbox-extra-roots 同约束）：edit(change)
 * 必须以 Loader 侧 current 为合并基并过 normalizeConfig——用 apply 时刻快照
 * 为基会覆盖用户在迁移前做的行编辑（丢配置）。
 */

let home: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-archive-migrate-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
})

function legacyCtx(captured: { change?: (current: Record<string, any>) => Record<string, any> }) {
  return {
    fiber: { entry: { id: 'session-archive' } },
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
  it('legacy 合并到 edit 时的 current 上并归一化，不丢弃行内已有编辑', async () => {
    const captured: { change?: (current: Record<string, any>) => Record<string, any> } = {}
    const dir = join(home!, 'plugins', 'test-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ titleReadConcurrency: 8 }))
    await migrateLegacyConfig('test-plugin', legacyCtx(captured) as any)
    expect(captured.change).toBeDefined()
    const merged = captured.change!({ detailMaxMessages: 100, titleReadConcurrency: 2 })
    expect(merged['detailMaxMessages']).toBe(100)
    expect(merged['titleReadConcurrency']).toBe(8)
  })

  it('无旧文件时不碰 editor', async () => {
    const captured: { change?: (current: Record<string, any>) => Record<string, any> } = {}
    await migrateLegacyConfig('test-plugin', legacyCtx(captured) as any)
    expect(captured.change).toBeUndefined()
  })
})
