/**
 * wsl-zcode-discovery.test.ts — WSL 环境下 Windows ZCode 跨环境凭据发现、白名单与解密测试。
 */

import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findWslWindowsUserDirs,
  isWsl,
  wslPathForWindows,
  wslPathVariantsForWindows,
} from '../src/wsl.js'
import { defaultZCodeDesktopCandidates } from '../src/auth-paths.js'
import {
  builtinConfigCandidates,
  codingPlanWhitelistFromConfig,
  readZcodeCodingPlanWhitelist,
} from '../src/zcode-builtin-catalog.js'
import {
  clearZCodeKeyCache,
  computeZCodeKeyFingerprint,
  decryptZCodeEncryptedKey,
  resolveKeyringPasswordViaHelper,
  resolveZCodeBin,
} from '../src/auth-zcode-crypto.js'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(os.tmpdir(), 'wsl-zcode-test-'))
  clearZCodeKeyCache()
})

afterEach(async () => {
  clearZCodeKeyCache()
  vi.unstubAllEnvs()
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
})

function sealV2(plaintext: string, key: Buffer, source: 'os' | 'env' = 'os'): string {
  const fingerprint = computeZCodeKeyFingerprint(key)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload = [iv, tag, body].map((part) => part.toString('base64url')).join('.')
  return `enc:v2:${source}:${fingerprint}:${payload}`
}

describe('WSL 路径转换（wslPathVariantsForWindows / wslPathForWindows）', () => {
  it('正确将 /mnt/<drive>/... 转换为 Windows 反斜杠与正斜杠路径', () => {
    const input = '/mnt/c/Users/developer/.zcode/v2/credentials.json'
    const variants = wslPathVariantsForWindows(input)
    expect(variants).toBeDefined()
    expect(variants?.backslash).toBe('C:\\Users\\developer\\.zcode\\v2\\credentials.json')
    expect(variants?.slash).toBe('C:/Users/developer/.zcode/v2/credentials.json')
    expect(wslPathForWindows(input)).toBe('C:\\Users\\developer\\.zcode\\v2\\credentials.json')
  })

  it('支持非 C 盘符与多层相对段规范化', () => {
    const input = '/mnt/d/Tools/ZCode/ZCode.exe'
    const variants = wslPathVariantsForWindows(input)
    expect(variants?.backslash).toBe('D:\\Tools\\ZCode\\ZCode.exe')
    expect(variants?.slash).toBe('D:/Tools/ZCode/ZCode.exe')
  })

  it('对已经是 Windows 路径的输入规范化盘符并生成变体', () => {
    const winInput = 'c:\\users\\test\\.zcode\\v2\\credentials.json'
    const variants = wslPathVariantsForWindows(winInput)
    expect(variants?.backslash).toBe('C:\\users\\test\\.zcode\\v2\\credentials.json')
    expect(variants?.slash).toBe('C:/users/test/.zcode/v2/credentials.json')
  })

  it('对普通 Linux 路径或空输入返回 undefined', () => {
    expect(wslPathVariantsForWindows('/home/dev/file.json')).toBeUndefined()
    expect(wslPathVariantsForWindows('')).toBeUndefined()
    expect(wslPathVariantsForWindows(undefined)).toBeUndefined()
    expect(wslPathForWindows('/var/log')).toBeUndefined()
  })
})

describe('WSL Windows 用户目录枚举（findWslWindowsUserDirs）', () => {
  it('优先使用 USERPROFILE 环境变量', () => {
    const fakeEnv = { USERPROFILE: 'C:\\Users\\SpecialUser' }
    const dirs = findWslWindowsUserDirs(fakeEnv, '/home/linuxuser')
    expect(dirs[0]).toBe('/mnt/c/Users/SpecialUser')
    expect(dirs).toContain('/mnt/c/Users/linuxuser')
  })

  it('无 USERPROFILE 时回退到基于 Linux 用户名的预测路径', () => {
    const dirs = findWslWindowsUserDirs({}, '/home/alice')
    expect(dirs).toContain('/mnt/c/Users/alice')
  })

  it('真实扫描 Windows 用户根目录并过滤系统非真实用户目录', async () => {
    const mockUsersRoot = join(tempDir, 'Users')
    await mkdir(join(mockUsersRoot, 'RealUser'), { recursive: true })
    await mkdir(join(mockUsersRoot, 'Public'), { recursive: true })
    await mkdir(join(mockUsersRoot, 'Default User'), { recursive: true })
    await writeFile(join(mockUsersRoot, 'desktop.ini'), '[.ShellClassInfo]')

    const dirs = findWslWindowsUserDirs({}, '/home/dummy', [mockUsersRoot])
    expect(dirs).toContain(join(mockUsersRoot, 'RealUser'))
    expect(dirs).not.toContain(join(mockUsersRoot, 'Public'))
    expect(dirs).not.toContain(join(mockUsersRoot, 'Default User'))
    expect(dirs).not.toContain(join(mockUsersRoot, 'desktop.ini'))
  })
})

describe('WSL 环境下 ZCode 凭据候选发现', () => {
  it('defaultZCodeDesktopCandidates 在 WSL 下包含 Windows 候选', () => {
    vi.stubEnv('USERPROFILE', 'C:\\Users\\winuser')
    const candidates = defaultZCodeDesktopCandidates('credentials.json')
    if (process.platform === 'linux' && isWsl()) {
      expect(candidates.some(c => c.includes('/mnt/c/Users/winuser/.zcode/v2/credentials.json'))).toBe(true)
    }
  })
})

describe('WSL 环境下 ZCode 白名单发现', () => {
  it('codingPlanWhitelistFromConfig 正确提取 bigmodel coding-plan 白名单', () => {
    const mockConfig = {
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'account:bigmodel-glm-coding-plan',
              config: {
                access: { accountType: 'bigmodel' },
                builtinModelIds: ['glm-5.3', 'GLM-5.3-Flash'],
              },
            },
            {
              providerId: 'account:other-provider',
              config: {
                access: { accountType: 'other' },
                builtinModelIds: ['other-model'],
              },
            },
          ],
        },
      },
    }
    const whitelist = codingPlanWhitelistFromConfig(mockConfig)
    expect(whitelist).toBeDefined()
    expect(whitelist?.has('glm-5.3')).toBe(true)
    expect(whitelist?.has('glm-5.3-flash')).toBe(true)
    expect(whitelist?.has('other-model')).toBe(false)
  })

  it('readZcodeCodingPlanWhitelist 支持通过 configuredPath 读取配置', async () => {
    const configPath = join(tempDir, 'zcode-builtin.json')
    const sampleConfig = {
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'account:bigmodel-custom-coding-plan',
              config: {
                access: { accountType: 'bigmodel' },
                builtinModelIds: ['glm-custom'],
              },
            },
          ],
        },
      },
    }
    await writeFile(configPath, JSON.stringify(sampleConfig), 'utf8')
    const whitelist = readZcodeCodingPlanWhitelist(configPath)
    expect(whitelist).toBeDefined()
    expect(whitelist?.has('glm-custom')).toBe(true)
  })

  it('builtinConfigCandidates 在 linux+WSL 下正确生成 Windows 与 Linux 候选', () => {
    const fakeEnv = {
      ProgramFiles: 'C:\\Program Files',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
    }
    const candidates = builtinConfigCandidates(undefined, 'linux', true, fakeEnv)
    expect(candidates).toContain('/mnt/c/Program Files/ZCode/resources/config/provider/zcode-builtin.json')
    expect(candidates).toContain('/mnt/c/Users/test/AppData/Local/Programs/ZCode/resources/config/provider/zcode-builtin.json')
    expect(candidates).toContain('/opt/ZCode/resources/config/provider/zcode-builtin.json')

    // 覆盖非 WSL 与空环境变量分支
    const noEnvCandidates = builtinConfigCandidates(undefined, 'linux', true, {})
    expect(noEnvCandidates).toContain('/mnt/c/Program Files/ZCode/resources/config/provider/zcode-builtin.json')

    const nonWslCandidates = builtinConfigCandidates(undefined, 'linux', false)
    expect(nonWslCandidates).toContain('/opt/ZCode/resources/config/provider/zcode-builtin.json')
    expect(nonWslCandidates).not.toContain('/mnt/c/Program Files/ZCode/resources/config/provider/zcode-builtin.json')

    expect(builtinConfigCandidates(undefined, 'freebsd' as NodeJS.Platform, false)).toEqual([])
  })

  it('运行时热更新缓存优先于安装目录静态副本，且最新版本优先', async () => {
    const homeRoot = tempDir
    const zcodeHome = join(homeRoot, '.zcode', 'v2')
    const doc = (ids: string[]) => JSON.stringify({
      config: { providerConfigRules: { providerRules: [
        { providerId: 'account:bigmodel-individual-coding-plan', config: { access: { accountType: 'bigmodel' }, builtinModelIds: ids } },
      ] } },
    })
    // 老版本 3.14.4（无 5.4）与新版本 4.0.0（含 5.4）共存；
    // 目录名字典序 3.14.4 在前，必须按 semver 降序让 4.0.0 先命中。
    for (const [version, ids] of [['3.14.4', ['GLM-5.3']], ['4.0.0', ['GLM-5.4', 'GLM-5.3']]] as const) {
      const dir = join(zcodeHome, 'runtime', 'provider', 'darwin-aarch64', version, 'endpoint-abc')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'zcode-builtin.json'), doc([...ids]), 'utf8')
    }
    const whitelist = readZcodeCodingPlanWhitelist(undefined, homeRoot)
    expect(whitelist?.has('glm-5.4')).toBe(true)
    const candidates = builtinConfigCandidates(undefined, 'darwin', false, {}, homeRoot)
    expect(candidates[0]).toContain(join('4.0.0', 'endpoint-abc'))
  })

  it('本机 ZCode 4.0 运行时缓存能发现 GLM-5.4（有安装时）', () => {
    if (process.platform !== 'darwin') return
    const whitelist = readZcodeCodingPlanWhitelist()
    if (whitelist === undefined) return // 未安装 ZCode 的机器无可断言
    expect(whitelist.has('glm-5.4')).toBe(true)
  })
})

describe('WSL 下 ZCode 可执行文件发现（resolveZCodeBin）', () => {
  it('在 linux+WSL 下根据环境变量和路径探测 Windows ZCode.exe', async () => {
    const fakeWinApp = join(tempDir, 'Programs', 'ZCode', 'ZCode.exe')
    await mkdir(join(fakeWinApp, '..'), { recursive: true })
    await writeFile(fakeWinApp, '')

    const fakeEnv = {
      LOCALAPPDATA: `C:${tempDir.replace(/^\/mnt\/[a-z]/i, '')}`,
    }
    // 当显式匹配到存在的文件时返回该路径
    const found = resolveZCodeBin(fakeWinApp, 'linux', true, fakeEnv)
    expect(found).toBe(fakeWinApp)
  })
})

describe('WSL 下 ZCode enc:v2 跨环境解密', () => {
  it('通过 Windows 原生路径计算的 account 能够被 keyResolver 成功命中并解密', () => {
    const rawKey = crypto.randomBytes(32)
    const plaintext = 'sk-windows-zcode-secret-token'
    const ciphertext = sealV2(plaintext, rawKey, 'os')

    const wslDesktopPath = '/mnt/c/Users/bob/.zcode/v2/credentials.json'
    const expectedWinAccount = crypto.createHash('sha256').update('C:\\Users\\bob\\.zcode\\v2\\credentials.json').digest('hex')

    let matchedAccount: string | undefined
    const decrypted = decryptZCodeEncryptedKey(ciphertext, {
      desktopPath: wslDesktopPath,
      keyResolver: (ctx) => {
        if (ctx.account === expectedWinAccount) {
          matchedAccount = ctx.account
          return rawKey
        }
        return undefined
      },
    })

    expect(decrypted).toBe(plaintext)
    expect(matchedAccount).toBe(expectedWinAccount)
  })

  it('如果 Windows 客户端使用正斜杠路径存入 Keyring，同样能匹配并解密', () => {
    const rawKey = crypto.randomBytes(32)
    const plaintext = 'sk-slash-path-token'
    const ciphertext = sealV2(plaintext, rawKey, 'os')

    const wslDesktopPath = '/mnt/c/Users/bob/.zcode/v2/credentials.json'
    const expectedSlashAccount = crypto.createHash('sha256').update('C:/Users/bob/.zcode/v2/credentials.json').digest('hex')

    let matchedAccount: string | undefined
    const decrypted = decryptZCodeEncryptedKey(ciphertext, {
      desktopPath: wslDesktopPath,
      keyResolver: (ctx) => {
        if (ctx.account === expectedSlashAccount) {
          matchedAccount = ctx.account
          return rawKey
        }
        return undefined
      },
    })

    expect(decrypted).toBe(plaintext)
    expect(matchedAccount).toBe(expectedSlashAccount)
  })

  it('resolveKeyringPasswordViaHelper 安全环境变量与 WSLENV 设置验证', () => {
    const fakeBin = join(tempDir, 'fake-zcode')
    expect(resolveKeyringPasswordViaHelper(fakeBin, ['test-account'], { isWsl: true })).toBeUndefined()
    expect(resolveKeyringPasswordViaHelper(fakeBin, [])).toBeUndefined()
  })
})
