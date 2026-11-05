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
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { anyConnectDomain, domainRateLimitPersistence, openStandaloneStateStore } from '../src/state-store.js'

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

describe('domainRateLimitPersistence（rate_limits 表）', () => {
  /** 最小 Domain 替身：只要 table().get/put/delete 与 close（真实语义在 storage-domain 包内回归）。 */
  function fakeDomain(): { domain: Domain<typeof anyConnectDomain>, table: (name: string) => Map<string, unknown> } {
    const tables = new Map<string, Map<string, unknown>>()
    const table = (name: string): Map<string, unknown> => {
      const found = tables.get(name) ?? new Map<string, unknown>()
      tables.set(name, found)
      return found
    }
    const domain = {
      table(name: string) {
        const records = table(name)
        return {
          get: async (key: string) => records.get(key),
          put: async (key: string, value: unknown) => { records.set(key, value) },
          delete: async (key: string) => { records.delete(key) },
        }
      },
      close: async () => {},
    }
    return { domain: domain as unknown as Domain<typeof anyConnectDomain>, table }
  }

  function observation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      provider: 'workbuddy',
      blockedAtMs: 1_000,
      lastSeenAtMs: 2_000,
      resetAtMs: 9_000,
      status: 429,
      kind: 'soft_rate',
      model: 'glm-5.3',
      policy: 'rpm',
      hits: 1,
      ...overrides,
    }
  }

  it('save 只持久化带 resetAt 的观测（一条记录放该 provider 的全部策略）', async () => {
    const { domain, table } = fakeDomain()
    const persistence = domainRateLimitPersistence(domain)
    await persistence.save('workbuddy', [
      observation(),
      observation({ policy: 'tpd', resetAtMs: undefined }),
    ] as never)
    expect(table('rate_limits').get('workbuddy')).toEqual({ observations: [observation()] })
  })

  it('save 空数组 → 删除记录（不留空壳）', async () => {
    const { domain, table } = fakeDomain()
    const persistence = domainRateLimitPersistence(domain)
    await persistence.save('workbuddy', [observation()] as never)
    expect(table('rate_limits').has('workbuddy')).toBe(true)
    await persistence.save('workbuddy', [])
    expect(table('rate_limits').has('workbuddy')).toBe(false)
  })

  it('load 返回记录里的观测；不存在时 undefined', async () => {
    const { domain, table } = fakeDomain()
    const persistence = domainRateLimitPersistence(domain)
    expect(await persistence.load('workbuddy')).toBeUndefined()
    table('rate_limits').set('workbuddy', { observations: [observation()] })
    expect(await persistence.load('workbuddy')).toEqual([observation()])
  })
})
