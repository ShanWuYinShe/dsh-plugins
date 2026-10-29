import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * landlock-exec 的解析与缓存语义。
 *
 * 钉住三个容易写坏的契约：
 * 1. 非 Linux 平台**同步**返回 null（签名是 Promise | null），且不加载 launcher；
 * 2. 连续调用共享同一个解析 Promise——重复解析会让 apply 路径反复扫盘；
 * 3. 解析失败**不缓存**：launcher 稍后安装/修复后，下一次 apply 重新探测，
 *    而不是到进程重启前都静默跳过（成功才永久缓存）。
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
  vi.resetModules()
  stubPlatform(realPlatform)
})

async function importModule() {
  return await import(new URL('../src/landlock-exec.js', import.meta.url).href)
}

describe('getLandlockRuntime', () => {
  // 合成一个用例：模块级缓存的生命周期贯穿整个文件，拆成多个 it 会因
  // vi.mock 工厂在每个 it 重新求值而让「只解析一次」的断言失真。
  it('缓存语义全链路：非 Linux 同步 null → Linux 解析一次并缓存 → 失败不缓存可重试', async () => {
    // --- 非 Linux：同步 null，且不加载 launcher ---
    stubPlatform('darwin')
    let mod = await importModule()
    expect(mod.getLandlockRuntime()).toBeNull()
    expect(mocks.launcherPath).not.toHaveBeenCalled()

    // --- Linux：解析成功，连续调用共享同一个 Promise ---
    stubPlatform('linux')
    mod = await importModule()
    await expect(mod.getLandlockRuntime()).resolves.toEqual({
      exec: '/usr/lib/landlock-run',
      grantArgs: expect.any(Function),
    })
    const first = mod.getLandlockRuntime()
    const second = mod.getLandlockRuntime()
    expect(second).toBe(first)
    expect(mocks.launcherPath).toHaveBeenCalledTimes(1)

    // --- 新模块实例（resetModules 后）：失败不缓存，下次调用重新探测 ---
    vi.resetModules()
    mocks.launcherPath.mockClear()
    mod = await importModule()
    mocks.launcherPath.mockImplementation(() => { throw new Error('platform package missing') })
    try {
      await expect(mod.getLandlockRuntime()).resolves.toBeNull()
      await expect(mod.getLandlockRuntime()).resolves.toBeNull()
      expect(mocks.launcherPath).toHaveBeenCalledTimes(2)
    } finally {
      mocks.launcherPath.mockImplementation(() => '/usr/lib/landlock-run')
    }
  })
})
