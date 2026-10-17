import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultWorkBuddyElectronPath,
  deriveProtectorKey,
  electronDiscoveryFor,
  WorkBuddyAtRestKeyProvider,
} from '../src/desktop-credential-protection.js'
import type { WorkBuddyWindowsDiscoveryTools } from '../src/desktop-credential-protection.js'
import { discoverWindowsApp } from '../src/desktop-app-discovery.js'
import type { AppDiscoveryContext } from '../src/desktop-app-discovery.js'
import type { WorkBuddyDiscoveryTools } from '../src/desktop-discovery.js'
import { inspectWindowsElectronCandidate } from '../src/desktop-discovery-windows.js'
import { appendWslEnvDirection, helperSpawnEnv } from '../src/wsl.js'
import { AI_VARIANT, CN_VARIANT, electronProfileFor } from '../src/variants.js'

const SECRET = Buffer.alloc(32, 9).toString('base64')
const PAYLOAD_TEXT = JSON.stringify({ version: 1, atRestSecretKey: SECRET })
const KEY = deriveProtectorKey(SECRET)
const KEY_ID = createHash('sha256').update(KEY).digest('hex').slice(0, 16)

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-wsl-electron-discovery-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function fakeWindowsTools(output: string, options: { fail?: boolean } = {}): WorkBuddyWindowsDiscoveryTools {
  return {
    queryUninstallRoot: async () => {
      if (options.fail === true) throw new Error('registry unavailable')
      return output
    },
  }
}

const noopMacTools: WorkBuddyDiscoveryTools = {
  findApps: async () => [],
  bundleIdentifier: async () => undefined,
  bundleVersion: async () => undefined,
}

/** 真实机器上的 WSL 默认布局推导（环境未注入 USERPROFILE 时按 Linux 用户名）。 */
function realDefaultPath(): string | undefined {
  return defaultWorkBuddyElectronPath(electronProfileFor(CN_VARIANT), 'linux', true)
}

describe('WSL 下的发现路由', () => {
  it('linux+WSL 走 windows-workbuddy，环境纯（不嗅探进程环境）', () => {
    expect(electronDiscoveryFor('linux', true)).toBe('windows-workbuddy')
    expect(electronDiscoveryFor('linux', false)).toBe('none')
    expect(electronDiscoveryFor('win32', false)).toBe('windows-workbuddy')
    expect(electronDiscoveryFor('win32', true)).toBe('windows-workbuddy')
    expect(electronDiscoveryFor('darwin', true)).toBe('macos-workbuddy')
    expect(electronDiscoveryFor('freebsd', true)).toBe('none')
  })

  function wslProvider(wsl: boolean, windowsTools: WorkBuddyWindowsDiscoveryTools): WorkBuddyAtRestKeyProvider {
    return new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: 'windows-workbuddy',
      platform: 'linux',
      wsl,
      // 指向不存在的默认路径，强制走到发现流程（本机 /mnt/c 可能真装着 App）。
      defaultElectronPath: join(root, 'absent', 'WorkBuddy.exe'),
      windowsTools,
      spawnHelper: async () => PAYLOAD_TEXT,
    })
  }

  it('wsl 打开平台门：注册表查不到 → 发现未完成（而非「平台未配置」）', async () => {
    await expect(wslProvider(true, fakeWindowsTools('', { fail: true })).protectorKeyFor([KEY_ID]))
      .rejects.toMatchObject({ reasonCode: 'electron-discovery-incomplete' })
  })

  it('非 WSL 的 linux 保持原 unavailable 门', async () => {
    await expect(wslProvider(false, fakeWindowsTools('')).protectorKeyFor([KEY_ID]))
      .rejects.toMatchObject({ reasonCode: 'electron-binary-unavailable' })
  })

  it('注册表候选经 /mnt 转换后判「不匹配布局」是可判定排除，不算未完成', async () => {
    const icon = 'C:\\Users\\someone\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe'
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{TEST-0}',
      '    DisplayName    REG_SZ    WorkBuddy 5.6.2',
      `    DisplayIcon    REG_SZ    ${icon}`,
    ].join('\r\n')
    const ctx: AppDiscoveryContext = {
      product: electronProfileFor(CN_VARIANT),
      tools: noopMacTools,
      windowsTools: fakeWindowsTools(output),
      platform: 'linux',
      discoveryBudgetMs: 200,
      wsl: true,
    }
    const error = await discoverWindowsApp(ctx).catch((caught: unknown) => caught)
    expect((error as { reasonCode?: string }).reasonCode).toBe('electron-binary-not-found')
    expect((error as Error).message).toContain('did not match the expected app layout')
  })
})

describe('defaultWorkBuddyElectronPath 的 WSL 默认布局推导', () => {
  it('USERPROFILE 命名时转换使用', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\liyou')
    expect(defaultWorkBuddyElectronPath(electronProfileFor(CN_VARIANT), 'linux', true))
      .toBe('/mnt/c/Users/liyou/AppData/Local/Programs/WorkBuddy/WorkBuddy.exe')
  })

  it('LOCALAPPDATA 优先于 USERPROFILE，盘符归一化', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\liyou')
    vi.stubEnv('LOCALAPPDATA', 'D:\\Data\\Local')
    expect(defaultWorkBuddyElectronPath(electronProfileFor(CN_VARIANT), 'linux', true))
      .toBe('/mnt/d/Data/Local/Programs/WorkBuddy/WorkBuddy.exe')
  })

  it('无环境信号时按 Linux 用户名猜挂载的用户目录', () => {
    vi.stubEnv('USERPROFILE', '')
    vi.stubEnv('LOCALAPPDATA', '')
    expect(defaultWorkBuddyElectronPath(electronProfileFor(CN_VARIANT), 'linux', true))
      .toBe(join('/mnt/c/Users', basename(homedir()), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
  })

  it('AI 版没有实测过的 Windows 默认布局；非 WSL 的 linux 推导不出', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\liyou')
    expect(defaultWorkBuddyElectronPath(electronProfileFor(AI_VARIANT), 'linux', true)).toBeUndefined()
    expect(defaultWorkBuddyElectronPath(electronProfileFor(CN_VARIANT), 'linux', false)).toBeUndefined()
  })

  it('win32 原样用 LOCALAPPDATA，不做 /mnt 转换（wsl 与否都不转）', () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\liyou\\AppData\\Local')
    // 期望值用 join 拼：分隔符随运行平台走，与实现的平台无关性对齐。
    const localAppData = 'C:\\Users\\liyou\\AppData\\Local'
    const expected = join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe')
    expect(defaultWorkBuddyElectronPath(electronProfileFor(CN_VARIANT), 'win32', false)).toBe(expected)
    expect(defaultWorkBuddyElectronPath(electronProfileFor(CN_VARIANT), 'win32', true)).toBe(expected)
  })
})

describe('WSL 下的候选布局校验', () => {
  it('linux+WSL 跳过 x-bit 校验（drvfs 权限呈现不可靠），布局仍全查', async () => {
    const installRoot = join(root, 'WorkBuddy')
    const exe = join(installRoot, 'WorkBuddy.exe')
    await mkdir(join(installRoot, 'resources'), { recursive: true })
    // 0644：原生路径上 accessSync(X_OK) 会失败；WSL 下以「是文件」放行。
    await writeFile(exe, '#!/bin/sh\n', { mode: 0o644 })
    await writeFile(join(installRoot, 'version'), '37.10.3-24')
    await writeFile(join(installRoot, 'resources', 'app.asar'), '')
    expect(inspectWindowsElectronCandidate(exe, 'linux', 'workbuddy.exe', true))
      .toMatchObject({ electronPath: exe })
    expect(inspectWindowsElectronCandidate(exe, 'linux', 'workbuddy.exe', false)).toBeUndefined()
  })
})

describe('助手子进程环境的 WSLENV 注入', () => {
  it('appendWslEnvDirection：追加 /w 方向、保留既有条目、不重复', () => {
    expect(appendWslEnvDirection(undefined, 'ELECTRON_RUN_AS_NODE')).toBe('ELECTRON_RUN_AS_NODE/w')
    expect(appendWslEnvDirection('WT_SESSION:WT_PROFILE_ID:', 'ELECTRON_RUN_AS_NODE'))
      .toBe('WT_SESSION:WT_PROFILE_ID:ELECTRON_RUN_AS_NODE/w')
    expect(appendWslEnvDirection('ELECTRON_RUN_AS_NODE/w', 'ELECTRON_RUN_AS_NODE')).toBe('ELECTRON_RUN_AS_NODE/w')
  })

  it('helperSpawnEnv：恒设 ELECTRON_RUN_AS_NODE；WSL 下挂进 WSLENV', () => {
    const base = { WSLENV: 'WT_SESSION', PATH: '/usr/bin' }
    const plain = helperSpawnEnv(base, false)
    expect(plain['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(plain['WSLENV']).toBe('WT_SESSION')
    const wsl = helperSpawnEnv(base, true)
    expect(wsl['ELECTRON_RUN_AS_NODE']).toBe('1')
    expect(wsl['WSLENV']).toBe('WT_SESSION:ELECTRON_RUN_AS_NODE/w')
    // 其余变量原样透传（桌面 App 可能依赖宿主常规环境）。
    expect(wsl['PATH']).toBe('/usr/bin')
  })

  it('spawnAt 真实发起的子进程断开了 stdin（防 interop 阻塞）', async () => {
    // 用一个真实存在的 Linux 假「Electron」：退出码与输出无关紧要，重点是
    // spawnAt 用 stdio:['ignore','pipe','pipe'] 时子进程立刻退出而非挂住。
    const fakeElectron = join(root, 'fake-electron.sh')
    await writeFile(fakeElectron, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      electronPath: fakeElectron,
      timeoutMs: 3_000,
      wsl: false,
    })
    await expect(provider.protectorKeyFor([KEY_ID]))
      .rejects.toMatchObject({ reasonCode: 'encrypted-credential-unreadable' })
    expect(statSync(fakeElectron).isFile()).toBe(true)
  }, 10_000)
})

// 真机端到端（不 spawn 助手，只验证发现链路拼出真实安装路径）：仅当本机是
// Linux、能从环境推导出 WSL 默认布局且该路径真实存在时运行（CI Linux 容器
// 自动跳过）。变体同款校验逻辑见 windows-electron-discovery.test.ts。
const realDefault = realDefaultPath()
const itReal = it.skipIf(process.platform !== 'linux' || realDefault === undefined || !existsSync(realDefault))

describe('真机 WSL2 端到端（发现链路）', () => {
  itReal('默认布局直达真实安装，无需显式配置或注册表', async () => {
    expect(realDefault).toBeDefined()
    let spawns = 0
    const provider = new WorkBuddyAtRestKeyProvider({
      product: electronProfileFor(CN_VARIANT),
      discovery: electronDiscoveryFor('linux', true),
      platform: 'linux',
      spawnHelper: async () => {
        spawns += 1
        return PAYLOAD_TEXT
      },
    })
    await expect(provider.protectorKeyFor([KEY_ID])).resolves.toBeInstanceOf(Buffer)
    expect(spawns).toBe(1)
    expect(provider.helperPath()).toBe(realDefault)
  })
})
