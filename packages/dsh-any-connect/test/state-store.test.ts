/**
 * state-store.test.ts — 自有凭据副本的状态域（storageDomain）持久化回归。
 *
 * 覆盖三块（2026-10-11 迁移，见 src/state-store.ts）：
 * 1. standalone 存取（CLI 与插件同一存储单元）的写/读/改/删闭环；
 * 2. 旧散文件迁移：根布局搬进域、搬完删源；
 * 3. 迁移边界：回落目录副本优先于旧根副本、损坏文件原样保留、空迁移 no-op。
 *
 * domainStateStore（宿主 Domain 句柄包装）不经单测：Domain 实例只能由宿主
 * DomainFacility.open 构造，其表语义（get/put/delete）在 storage-domain 包内
 * 有自己的回归；本包的端到端验证走隔离实例（真实宿主 open 域后由卡片/刷新
 * 链路覆盖）。
 *
 * @module dsh-any-connect/state-store-test
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  migrateLegacyCredentialFiles,
  openStandaloneStateStore,
} from '../src/state-store.js'
import { legacyOwnAuthPath, workbuddyOwnAuthPath } from '../src/auth-paths.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

const BASE_CREDENTIAL = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAtMs: 1_000,
  domain: 'example.com',
  uid: 'u1',
  source: 'dsh' as const,
}

/** 旧根布局的 ownDocument 形态（version 包装，见 auth-document.ts）。 */
function legacyDocument(uid: string): string {
  return `${JSON.stringify({ version: 1, credential: { ...BASE_CREDENTIAL, uid } }, null, 2)}\n`
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8')
    return true
  } catch {
    return false
  }
}

describe('state-store', () => {
  it('standalone store: write / read / overwrite / clear round-trips through the shared unit', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-state-'))
    vi.stubEnv('DSH_HOME', root)
    const state = await openStandaloneStateStore()
    try {
      expect(await state.read('workbuddy')).toBeUndefined()

      await state.write('workbuddy', { ...BASE_CREDENTIAL })
      expect((await state.read('workbuddy'))?.uid).toBe('u1')

      // 覆盖写（refresh 场景）：同键新值生效。
      await state.write('workbuddy', { ...BASE_CREDENTIAL, uid: 'u2' })
      expect((await state.read('workbuddy'))?.uid).toBe('u2')

      // 各变体互不影响（一张表四个键）。
      await state.write('zcode-sp', { ...BASE_CREDENTIAL, uid: 'sp1' })
      expect((await state.read('workbuddy'))?.uid).toBe('u2')
      expect((await state.read('zcode-sp'))?.uid).toBe('sp1')

      await state.clear('workbuddy')
      expect(await state.read('workbuddy')).toBeUndefined()
      // clear 一个已不存在的键同样成功（logout 幂等）。
      await state.clear('workbuddy')
    } finally {
      await state.close()
    }
  })

  it('standalone store: rejects a record that violates the credential schema', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-state-bad-'))
    vi.stubEnv('DSH_HOME', root)
    const state = await openStandaloneStateStore()
    try {
      // accessToken 缺失 → schema 拒绝（类型化持久化的核心承诺）。
      await expect(state.write('workbuddy', { ...BASE_CREDENTIAL, accessToken: undefined as unknown as string })).rejects.toThrow()
    } finally {
      await state.close()
    }
  })

  it('migrate: legacy root files move into the domain and are removed', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-state-mig-'))
    vi.stubEnv('DSH_HOME', root)
    await mkdir(join(root, '.dsh-any-connect'), { recursive: true })
    await writeFile(legacyOwnAuthPath('.workbuddy-auth.json'), legacyDocument('legacy'), 'utf8')
    await writeFile(legacyOwnAuthPath('.zcode-sp-auth.json'), legacyDocument('legacy-sp'), 'utf8')

    const state = await openStandaloneStateStore()
    try {
      const migrated = await migrateLegacyCredentialFiles(state, legacyOwnAuthPath, workbuddyOwnAuthPath)
      expect(migrated).toContain(legacyOwnAuthPath('.workbuddy-auth.json'))
      expect(migrated).toContain(legacyOwnAuthPath('.zcode-sp-auth.json'))
      // 源文件已删、域里可读。
      expect(await exists(legacyOwnAuthPath('.workbuddy-auth.json'))).toBe(false)
      expect((await state.read('workbuddy'))?.uid).toBe('legacy')
      expect((await state.read('zcode-start-plan'))?.uid).toBe('legacy-sp')
    } finally {
      await state.close()
    }
  })

  it('migrate: the fallback-dir copy wins over the legacy-root copy of the same variant', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-state-both-'))
    vi.stubEnv('DSH_HOME', root)
    await mkdir(join(root, '.dsh-any-connect'), { recursive: true })
    await writeFile(legacyOwnAuthPath('.workbuddy-auth.json'), legacyDocument('from-root'), 'utf8')
    await writeFile(workbuddyOwnAuthPath('.workbuddy-auth.json'), legacyDocument('from-fallback'), 'utf8')

    const state = await openStandaloneStateStore()
    try {
      await migrateLegacyCredentialFiles(state, legacyOwnAuthPath, workbuddyOwnAuthPath)
      // 回落目录的那份是更晚的回落写，必须胜出；两处源文件都被清掉。
      expect((await state.read('workbuddy'))?.uid).toBe('from-fallback')
      expect(await exists(legacyOwnAuthPath('.workbuddy-auth.json'))).toBe(false)
      expect(await exists(workbuddyOwnAuthPath('.workbuddy-auth.json'))).toBe(false)
    } finally {
      await state.close()
    }
  })

  it('migrate: an unreadable legacy file is kept untouched and does not block the rest', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-state-broken-'))
    vi.stubEnv('DSH_HOME', root)
    await mkdir(join(root, '.dsh-any-connect'), { recursive: true })
    await writeFile(legacyOwnAuthPath('.workbuddy-auth.json'), '{ not json', 'utf8')
    await writeFile(legacyOwnAuthPath('.workbuddy-ai-auth.json'), legacyDocument('ai'), 'utf8')
    const warnings: string[] = []

    const state = await openStandaloneStateStore()
    try {
      const migrated = await migrateLegacyCredentialFiles(
        state,
        legacyOwnAuthPath,
        workbuddyOwnAuthPath,
        message => warnings.push(message),
      )
      // 损坏文件原样保留（绝不吞掉用户的落盘副本），可读的照常搬。
      expect(await exists(legacyOwnAuthPath('.workbuddy-auth.json'))).toBe(true)
      expect(migrated).toContain(legacyOwnAuthPath('.workbuddy-ai-auth.json'))
      expect((await state.read('workbuddy-ai'))?.uid).toBe('ai')
      expect(warnings.some(message => message.includes('.workbuddy-auth.json'))).toBe(true)
    } finally {
      await state.close()
    }
  })

  it('migrate: no legacy files is a no-op', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-state-none-'))
    vi.stubEnv('DSH_HOME', root)
    const state = await openStandaloneStateStore()
    try {
      expect(await migrateLegacyCredentialFiles(state, legacyOwnAuthPath, workbuddyOwnAuthPath)).toEqual([])
    } finally {
      await state.close()
    }
  })
})
