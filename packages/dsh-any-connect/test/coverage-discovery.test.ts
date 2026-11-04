import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * desktop-discovery 的平台分支与子进程工具层（覆盖率补齐）。
 *
 * 用 vi.mock 替换 node:child_process：这些用例要验证的是「发现工具如何解释
 * 子进程的三种结局（成功/失败/被预算取消）」，而不是真的去跑 mdfind/plutil。
 */

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  DiscoveryIncompleteError,
  WORKBUDDY_ELECTRON_BIN_ENV,
  defaultWorkBuddyElectronPath,
  electronDiscoveryFor,
  workBuddyDiscoveryTools,
} from '../src/desktop-discovery.js'
import { CN_VARIANT, AI_VARIANT } from '../src/variants.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  execFileMock.mockReset()
})

/** 一个最小的假 ChildProcess（发现工具只用 kill/on）。 */
function fakeChild(): { kill: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } {
  return { kill: vi.fn(), on: vi.fn() }
}

describe('workBuddyDiscoveryTools：子进程结局的解释', () => {
  it('成功：mdfind 输出的每行 .app 成为候选', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
      cb(null, '/Applications/A.app\n/Users/x/Applications/B.app\n')
      return fakeChild()
    })
    const tools = workBuddyDiscoveryTools('com.test.app')
    await expect(tools.findApps(new AbortController().signal)).resolves.toEqual([
      '/Applications/A.app',
      '/Users/x/Applications/B.app',
    ])
  })

  it('子进程超时：失败原因说明是 timed out，而不是「没找到」', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
      cb(Object.assign(new Error('kill'), { killed: true }))
      return fakeChild()
    })
    const tools = workBuddyDiscoveryTools('com.test.app')
    await expect(tools.findApps(new AbortController().signal)).rejects.toBeInstanceOf(DiscoveryIncompleteError)
    await expect(tools.findApps(new AbortController().signal)).rejects.toThrow(/timed out/u)
  })

  it('预算已花完：不启动子进程，直接按「未完成」失败', async () => {
    const controller = new AbortController()
    controller.abort()
    const tools = workBuddyDiscoveryTools('com.test.app')
    await expect(tools.findApps(controller.signal)).rejects.toThrow(/budget was already spent/u)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('运行中被取消：kill 子进程并报「abandoned」', async () => {
    let callback: ((error: unknown, stdout: string) => void) | undefined
    const child = fakeChild()
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: unknown, cb: typeof callback) => {
      callback = cb
      return child
    })
    const controller = new AbortController()
    const tools = workBuddyDiscoveryTools('com.test.app')
    const pending = tools.findApps(controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow(/abandoned/u)
    expect(child.kill).toHaveBeenCalled()
    // 取消后的迟到回调不得二次 settle（settled 守卫）。
    expect(() => callback?.(null, '/late.app\n')).not.toThrow()
  })

  it('plutil 读取 bundle id：成功给值，失败返回 undefined（「无法核对」不等于「不匹配」）', async () => {
    execFileMock.mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
      cb(null, 'com.test.app\n')
      return fakeChild()
    }).mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
      cb(new Error('unreadable'))
      return fakeChild()
    })
    const tools = workBuddyDiscoveryTools('com.test.app')
    await expect(tools.bundleIdentifier('/Applications/A.app', new AbortController().signal)).resolves.toBe('com.test.app')
    await expect(tools.bundleIdentifier('/Applications/B.app', new AbortController().signal)).resolves.toBeUndefined()
  })

  it('plutil 读取版本：空串与失败都返回 undefined（版本只是 best effort）', async () => {
    execFileMock.mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
      cb(null, '  \n')
      return fakeChild()
    }).mockImplementationOnce((_bin: string, _args: string[], _opts: unknown, cb: (e: unknown) => void) => {
      cb(new Error('nope'))
      return fakeChild()
    })
    const tools = workBuddyDiscoveryTools('com.test.app')
    await expect(tools.bundleVersion('/Applications/A.app', new AbortController().signal)).resolves.toBeUndefined()
    await expect(tools.bundleVersion('/Applications/B.app', new AbortController().signal)).resolves.toBeUndefined()
  })
})

describe('平台默认路径与发现开关', () => {
  it('macOS 用各产品实测安装布局', () => {
    expect(defaultWorkBuddyElectronPath(CN_VARIANT.electron!, 'darwin')).toBe('/Applications/WorkBuddy.app/Contents/MacOS/Electron')
    expect(defaultWorkBuddyElectronPath(AI_VARIANT.electron!, 'darwin')).toBe('/Applications/WorkBuddy AI.app/Contents/MacOS/Electron')
  })

  it('Windows 缺 LOCALAPPDATA 时不猜默认路径；给了才拼装', () => {
    vi.stubEnv('LOCALAPPDATA', '')
    expect(defaultWorkBuddyElectronPath(CN_VARIANT.electron!, 'win32')).toBeUndefined()
    const localAppData = 'C:\\Users\\u\\AppData\\Local'
    vi.stubEnv('LOCALAPPDATA', localAppData)
    // 期望值用运行时 join 拼：本函数是平台无关的路径拼接（测试机是 darwin）。
    expect(defaultWorkBuddyElectronPath(CN_VARIANT.electron!, 'win32')).toBe(join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
    // 国际版没有实测默认布局：registry-only，绝不猜。
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local')
    expect(defaultWorkBuddyElectronPath(AI_VARIANT.electron!, 'win32')).toBeUndefined()
  })

  it('WSL 下把 Windows 默认布局映射到 /mnt；非 WSL Linux 不猜', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\wslu')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\wslu\\AppData\\Local')
    expect(defaultWorkBuddyElectronPath(CN_VARIANT.electron!, 'linux', true)).toBe('/mnt/c/Users/wslu/AppData/Local/Programs/WorkBuddy/WorkBuddy.exe')
    expect(defaultWorkBuddyElectronPath(CN_VARIANT.electron!, 'linux', false)).toBeUndefined()
  })

  it('发现开关按平台选择；Linux 只有 WSL 才启用 Windows 搜索', () => {
    expect(electronDiscoveryFor('darwin', false)).toBe('macos-workbuddy')
    expect(electronDiscoveryFor('win32', false)).toBe('windows-workbuddy')
    expect(electronDiscoveryFor('linux', true)).toBe('windows-workbuddy')
    expect(electronDiscoveryFor('linux', false)).toBe('none')
    expect(electronDiscoveryFor('freebsd' as NodeJS.Platform, false)).toBe('none')
  })

  it('显式 Electron 环境变量名是产品专属的单一事实', () => {
    expect(WORKBUDDY_ELECTRON_BIN_ENV).toBe('WORKBUDDY_ELECTRON_BIN')
    expect(CN_VARIANT.electron?.envVar).toBe('WORKBUDDY_ELECTRON_BIN')
    expect(AI_VARIANT.electron?.envVar).toBe('WORKBUDDY_AI_ELECTRON_BIN')
  })
})
