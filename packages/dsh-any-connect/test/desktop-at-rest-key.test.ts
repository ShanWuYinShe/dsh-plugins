/**
 * at-rest 保护密钥解析器的契约测试。
 *
 * 2026-10-08 补：这个类（482 行）此前没有任何直接测试，而它守着「加密凭据能不能解开」这条线——
 * 解析失败、keyId 不匹配、缓存/并发语义错了，用户看到的是「登不进去」，而报错信息指向别处。
 *
 * 构造器刻意保持无 I/O、所有外部依赖（source / spawnHelper / tools / platform）都可注入，
 * 因此这里不需要真的启动 Electron：用合成 product（envVar 独一份，杜绝环境变量干扰）+
 * 注入 source 即可覆盖核心契约。
 */

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { WorkBuddyAtRestKeyProvider, atRestKeyProviderFor } from '../src/desktop-at-rest-key.js'
import type { WorkBuddyElectronProduct } from '../src/variants.js'

const PRODUCT: WorkBuddyElectronProduct = {
  productName: 'Test Buddy',
  envVar: '__TEST_AT_REST_ELECTRON_PATH__',
  macOS: { bundleId: 'com.example.test-buddy', defaultPath: '/Applications/TestBuddy.app/Contents/MacOS/TestBuddy' },
  windows: { displayNamePattern: /Test Buddy/i, exeBasename: 'TestBuddy.exe' },
}

const SECRET = Buffer.alloc(32, 7).toString('base64')
const PAYLOAD = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = createHash('sha256').update(SECRET, 'utf8').digest()
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

function providerWith(options: Record<string, unknown> = {}) {
  return new WorkBuddyAtRestKeyProvider({ product: PRODUCT, discovery: 'none', ...options })
}

describe('WorkBuddyAtRestKeyProvider.helperPath', () => {
  it('显式路径优先，且不受 discovery 影响', () => {
    const provider = providerWith({ electronPath: '/custom/Electron', discovery: 'macos-workbuddy' })
    expect(provider.helperPath()).toBe('/custom/Electron')
  })

  it('discovery 为 none 时没有可报告的路径', () => {
    expect(providerWith().helperPath()).toBeUndefined()
  })

  it('discovery 开启时报告平台默认路径', () => {
    const provider = providerWith({
      discovery: 'macos-workbuddy',
      platform: 'darwin',
      defaultElectronPath: '/Applications/Default.app/Contents/MacOS/Default',
    })
    expect(provider.helperPath()).toBe('/Applications/Default.app/Contents/MacOS/Default')
  })
})

describe('WorkBuddyAtRestKeyProvider.protectorKeyFor', () => {
  it('没有任何 key id 时直接报错（不触发解析）', async () => {
    const source = vi.fn(async () => PAYLOAD)
    await expect(providerWith({ source }).protectorKeyFor([])).rejects.toThrow(/no key ids/)
    expect(source).not.toHaveBeenCalled()
  })

  it('解析出与请求匹配的 key', async () => {
    const key = await providerWith({ source: async () => PAYLOAD }).protectorKeyFor([KEY_ID])
    expect(key.equals(KEY)).toBe(true)
  })

  it('keyId 与请求不匹配时报错（凭据由另一个安装密封）', async () => {
    await expect(providerWith({ source: async () => PAYLOAD }).protectorKeyFor(['deadbeefdeadbeef']))
      .rejects.toThrow(/different WorkBuddy installation/)
  })

  it('载荷不可用时报错', async () => {
    for (const bad of ['not json', JSON.stringify({ version: 2, atRestSecretKey: SECRET }), JSON.stringify({ version: 1, atRestSecretKey: 'short' })]) {
      await expect(providerWith({ source: async () => bad }).protectorKeyFor([KEY_ID]))
        .rejects.toThrow(/unusable at-rest payload/)
    }
  })

  it('命中缓存后不再调用 source', async () => {
    const source = vi.fn(async () => PAYLOAD)
    const provider = providerWith({ source })
    await provider.protectorKeyFor([KEY_ID])
    await provider.protectorKeyFor([KEY_ID])
    expect(source).toHaveBeenCalledTimes(1)
  })

  it('并发调用共享同一次解析（inflight 去重）', async () => {
    const source = vi.fn(async () => PAYLOAD)
    const provider = providerWith({ source })
    const [a, b] = await Promise.all([provider.protectorKeyFor([KEY_ID]), provider.protectorKeyFor([KEY_ID])])
    expect(source).toHaveBeenCalledTimes(1)
    expect(a.equals(b)).toBe(true)
  })

  it('解析失败后可重试（不缓存失败）', async () => {
    let attempt = 0
    const source = vi.fn(async () => {
      attempt += 1
      return attempt === 1 ? 'broken' : PAYLOAD
    })
    const provider = providerWith({ source })
    await expect(provider.protectorKeyFor([KEY_ID])).rejects.toThrow(/unusable at-rest payload/)
    expect((await provider.protectorKeyFor([KEY_ID])).equals(KEY)).toBe(true)
  })
})

describe('atRestKeyProviderFor', () => {
  it('按变体返回一个 provider（host 与 CLI 共用同一入口）', () => {
    const provider = atRestKeyProviderFor({ id: 'workbuddy', electron: PRODUCT })
    expect(provider).toBeInstanceOf(WorkBuddyAtRestKeyProvider)
  })
})
