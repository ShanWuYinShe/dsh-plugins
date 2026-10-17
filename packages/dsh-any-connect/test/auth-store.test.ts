/**
 * 凭据存储的契约测试（刷新策略、区域守卫、登出）。
 *
 * 2026-10-08 补：这是包里最大的文件（465 行）且此前没有直接测试，而它守着三条用户可见的线——
 * 「token 该不该刷」「别区的 token 绝不能发出去」「登出后不能复活」。构造器把 refresh 与两份
 * 文件路径都做成可注入，因此用临时目录 + 假 refresh 就能覆盖，不需要真的桌面端。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth-store.js'
import { ownDocument } from '../src/auth-document.js'
import { CN_VARIANT } from '../src/variants.js'
import type { WorkBuddyCredential, WorkBuddyStoreOptions } from '../src/auth-types.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-store-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function credential(overrides: Partial<WorkBuddyCredential> = {}): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    source: 'dsh',
    ...overrides,
  }
}

function makeStore(overrides: Partial<WorkBuddyStoreOptions> = {}) {
  const dir = tempDir()
  const ownPath = join(dir, 'own.json')
  const refresh = vi.fn(async () => ({ accessToken: 'refreshed', refreshToken: 'rt2', expiresInSec: 3600 }))
  const store = new WorkBuddyCredentialStore({
    variant: CN_VARIANT,
    refresh,
    ownPath,
    // 桌面文件指到不存在的路径：用例只走插件自有副本这条线。
    desktopPath: join(dir, 'no-such-desktop.json'),
    onWarning: () => {},
    ...overrides,
  })
  return { store, ownPath, dir, refresh }
}

function writeOwn(path: string, cred: WorkBuddyCredential): void {
  writeFileSync(path, JSON.stringify(ownDocument(cred)))
}

describe('WorkBuddyCredentialStore', () => {
  it('ownAuthPath 返回注入的自有副本路径', () => {
    const { store, ownPath } = makeStore()
    expect(store.ownAuthPath()).toBe(ownPath)
  })

  it('两份文件都不存在时 current() 为 undefined、status 为 signed-out', async () => {
    const { store } = makeStore()
    expect(await store.current()).toBeUndefined()
    expect((await store.status()).state).toBe('signed-out')
  })

  it('读到自有副本：source 为 dsh，未进入刷新窗口时不调 refresh', async () => {
    const { store, ownPath, refresh } = makeStore()
    writeOwn(ownPath, credential())
    const current = await store.current()
    expect(current?.accessToken).toBe('at')
    expect(current?.source).toBe('dsh')
    expect((await store.resolve()).accessToken).toBe('at')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('区域错配时抛错（别区 token 绝不发出去）', async () => {
    const { store, ownPath } = makeStore()
    // global 域的凭据出现在 CN 变体的存储里：共享同一个 auth 目录，配错很现实。
    writeOwn(ownPath, credential({ domain: 'www.workbuddy.ai' }))
    await expect(store.current()).rejects.toThrow(/region|WorkBuddy AI/i)
    expect((await store.status()).state).toBe('signed-out')
  })

  it('进入刷新窗口时刷新一次并返回新 token', async () => {
    const { store, ownPath, refresh } = makeStore()
    writeOwn(ownPath, credential({ expiresAtMs: Date.now() + 60_000 }))
    const resolved = await store.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(resolved.accessToken).toBe('refreshed')
  })

  it('刷新失败但现值仍可用时返回现值（刷新端点故障不该拖垮会话）', async () => {
    const failing = vi.fn(async () => { throw new Error('network down') })
    const { store, ownPath } = makeStore({ refresh: failing })
    writeOwn(ownPath, credential({ expiresAtMs: Date.now() + 60_000 }))
    expect((await store.resolve()).accessToken).toBe('at')
  })

  it('刷新失败且现值几乎过期时抛错（如实报告而不是发一个将死的 token）', async () => {
    const failing = vi.fn(async () => { throw new Error('network down') })
    const { store, ownPath } = makeStore({ refresh: failing })
    writeOwn(ownPath, credential({ expiresAtMs: Date.now() + 10_000 }))
    await expect(store.resolve()).rejects.toThrow(/refresh failed/)
  })

  it('logout() 删掉自有副本，之后 current() 为 undefined', async () => {
    const { store, ownPath } = makeStore()
    writeOwn(ownPath, credential())
    expect(existsSync(ownPath)).toBe(true)
    await store.logout()
    expect(existsSync(ownPath)).toBe(false)
    expect(await store.current()).toBeUndefined()
  })
})
