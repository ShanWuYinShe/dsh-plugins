/**
 * state-store.test.ts — 自有凭据副本的状态域（storageDomain）持久化回归。
 *
 * 覆盖 standalone 存取（CLI 与插件同一存储单元）的写/读/改/删闭环与类型化
 * 校验。旧散文件迁移（根布局 → 域）已随 0.2.2-alpha.2 适配删除（见
 * src/state-store.ts 模块注释），不再有迁移用例。
 *
 * domainStateStore（宿主 Domain 句柄包装）不经单测：Domain 实例只能由宿主
 * DomainFacility.open 构造，其表语义（get/put/delete）在 storage-domain 包内
 * 有自己的回归；本包的端到端验证走隔离实例（真实宿主 open 域后由卡片/刷新
 * 链路覆盖）。
 *
 * @module dsh-any-connect/state-store-test
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStandaloneStateStore } from '../src/state-store.js'

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
})
