import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * landlock-exec 的解析与缓存语义。
 *
 * 21 行的小模块钉着三个容易写坏的契约：
 * 1. 非 Linux 平台**同步**返回 null（签名是 Promise | null），且不触发 loadLandlock；
 * 2. 连续调用共享同一个解析 Promise——重复解析会让 apply 路径反复扫盘；
 * 3. 解析失败**不缓存**：launcher 稍后安装/修复后，下一次 apply 重新探测，
 *    而不是到进程重启前都静默跳过（成功才永久缓存）。
 *
 * 取证记录（2026-10-08）：用**相对路径**动态 import 时，vi.resetModules() 后
 * landlock-exec 与测试取回的 common.js 可能不是同一实例，mock 计数会虚增（缓存明明
 * 生效却报调用 2/3 次）。改用**绝对路径**动态 import 后行为正确——实现本身没问题，
 * 是测试的模块解析口径不一致。这坑记下，别再踩。
 *
 * process.platform 是只读属性，用 Object.defineProperty 打桩；用完必须还原，
 * 否则会污染同文件后续用例（以及同 worker 的其它测试文件）。
 */

vi.mock('../src/common.js', () => ({ loadLandlock: vi.fn() }))

const realPlatform = process.platform

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  vi.resetModules()
  stubPlatform(realPlatform)
})

async function importModule() {
  const mod = await import(new URL('../src/landlock-exec.js', import.meta.url).href)
  const common = await import(new URL('../src/common.js', import.meta.url).href)
  return { mod, loadLandlock: vi.mocked(common.loadLandlock) }
}

describe('getLandlockExec', () => {
  // 合成一个用例：模块级缓存的生命周期贯穿整个文件，拆成多个 it 会因
  // vi.mock 工厂在每个 it 重新求值而让「只解析一次」的断言失真（实测报 2/3 次）。
  // 顺序也重要：先测同步 null（不触发解析），再测 Linux 缓存与失败缓存。
  it('缓存语义全链路：非 Linux 同步 null → Linux 解析一次并缓存 → 失败不缓存可重试', async () => {
    // --- 非 Linux：同步 null，且不触发 loadLandlock ---
    stubPlatform('darwin')
    let { mod, loadLandlock } = await importModule()
    expect(mod.getLandlockExec()).toBeNull()
    expect(loadLandlock).not.toHaveBeenCalled()

    // --- Linux：解析成功，连续调用共享同一个 Promise ---
    stubPlatform('linux')
    ;({ mod, loadLandlock } = await importModule())
    loadLandlock.mockResolvedValue({ launcherPath: () => '/usr/lib/landlock-exec' })
    await expect(mod.getLandlockExec()).resolves.toBe('/usr/lib/landlock-exec')
    const first = mod.getLandlockExec()
    const second = mod.getLandlockExec()
    expect(second).toBe(first)
    expect(loadLandlock).toHaveBeenCalledTimes(1)

    // --- 新模块实例（resetModules 后）：失败不缓存，下次调用重新探测 ---
    vi.resetModules()
    loadLandlock.mockClear() // 新实例的计数从 0 起算（vi.fn 是工厂闭包的同一个，不随 resetModules 重置）
    ;({ mod, loadLandlock } = await importModule())
    loadLandlock.mockRejectedValue(new Error('not found'))
    await expect(mod.getLandlockExec()).resolves.toBeNull()
    await expect(mod.getLandlockExec()).resolves.toBeNull()
    expect(loadLandlock).toHaveBeenCalledTimes(2)
  })
})
