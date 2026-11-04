import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * landlock-exec 的实例级懒加载语义。
 *
 * 钉住三个容易写坏的契约：
 * 1. 非 Linux 平台**同步**返回 null（签名是 Promise | null），且不加载 launcher；
 * 2. 同一个 loader 实例连续调用共享同一个解析 Promise——重复解析会让 apply
 *    路径反复扫盘；
 * 3. 解析失败**不缓存**：launcher 稍后安装/修复后，下一次 get() 重新探测，
 *    而不是到进程重启前都静默跳过（成功才永久缓存）。
 *
 * 缓存是**实例级**（apply 创建的 loader 持有），不再有模块级 singleton：
 * 因此这里用 createLandlockRuntimeLoader() 建实例，不依赖模块重载来重置状态。
 *
 * 官方入口是 @deepseek-ai/node-addon-system/landlock-run（0.2.2 起；旧包
 * @deepseek-ai/node-addon-landlock-run 已不在宿主安装里），用 vi.mock 注入。
 *
 * process.platform 用 Object.defineProperty 打桩；用完必须还原。
 */

const mocks = vi.hoisted(() => ({
  launcherPath: vi.fn(() => '/usr/lib/landlock-run'),
  grantArgs: vi.fn((grants: { readWrite?: readonly string[] }) => (grants.readWrite ?? []).flatMap((root) => ['--rw', root])),
}))

vi.mock('@deepseek-ai/node-addon-system/landlock-run', () => mocks)

const realPlatform = process.platform

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  stubPlatform(realPlatform)
})

async function importModule() {
  return await import(new URL('../src/landlock-exec.js', import.meta.url).href)
}

describe('createLandlockRuntimeLoader', () => {
  it('缓存语义全链路：非 Linux 同步 null → Linux 解析一次并缓存 → 失败不缓存可重试', async () => {
    const mod = await importModule()

    // --- 非 Linux：同步 null，且不加载 launcher ---
    stubPlatform('darwin')
    const nonLinux = mod.createLandlockRuntimeLoader()
    expect(nonLinux.get()).toBeNull()
    expect(mocks.launcherPath).not.toHaveBeenCalled()

    // --- Linux：解析成功，连续调用共享同一个 Promise ---
    stubPlatform('linux')
    const loader = mod.createLandlockRuntimeLoader()
    await expect(loader.get()).resolves.toEqual({
      exec: '/usr/lib/landlock-run',
      grantArgs: expect.any(Function),
    })
    const first = loader.get()
    const second = loader.get()
    expect(second).toBe(first)
    expect(mocks.launcherPath).toHaveBeenCalledTimes(1)

    // --- 失败不缓存：同一 loader 内下一次 get() 重新探测 ---
    mocks.launcherPath.mockClear()
    mocks.launcherPath.mockImplementation(() => { throw new Error('platform package missing') })
    try {
      const failing = mod.createLandlockRuntimeLoader()
      await expect(failing.get()).resolves.toBeNull()
      await expect(failing.get()).resolves.toBeNull()
      expect(mocks.launcherPath).toHaveBeenCalledTimes(2)
    } finally {
      mocks.launcherPath.mockImplementation(() => '/usr/lib/landlock-run')
    }
  })

  it('loader 实例互不共享缓存（不再有模块级 singleton）', async () => {
    const mod = await importModule()
    stubPlatform('linux')
    mocks.launcherPath.mockClear()
    const a = mod.createLandlockRuntimeLoader()
    const b = mod.createLandlockRuntimeLoader()
    await a.get()
    await b.get()
    // 两个实例各自解析一次：缓存随实例，不跨实例复用。
    expect(mocks.launcherPath).toHaveBeenCalledTimes(2)
  })
})
