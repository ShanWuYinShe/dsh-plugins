import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultDesktopAuthCandidates,
  parseWorkBuddyAuth,
  WorkBuddyCredentialStore,
  WORKBUDDY_AUTH_FILE_ENV,
  type WorkBuddyCredential,
} from '../src/auth.js'

// node:os's ESM namespace rejects vi.spyOn (non-configurable), so homedir is
// mocked at the module level; unset state falls through to the real one.
const fakeOs = vi.hoisted(() => ({
  home: undefined as string | undefined,
  release: undefined as string | undefined,
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => fakeOs.home ?? actual.homedir(),
    release: () => fakeOs.release ?? actual.release(),
  }
})

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

function nestedDoc(expiresAt: number): string {
  return JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1', enterpriseId: 'ent-1', nickname: '昵称' },
  })
}

describe('parseWorkBuddyAuth', () => {
  it('reads the desktop nested form with millisecond expiry', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236_868))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.refreshToken).toBe('rt')
    expect(credential?.expiresAtMs).toBe(1_792_128_236_868)
    expect(credential?.uid).toBe('uid-1')
    expect(credential?.enterpriseId).toBe('ent-1')
    expect(credential?.nickname).toBe('昵称')
  })

  it('normalizes second-precision expiry to milliseconds', () => {
    const credential = parseWorkBuddyAuth(nestedDoc(1_792_128_236))
    expect(credential?.expiresAtMs).toBe(1_792_128_236_000)
  })

  it('reads the flat panel form', () => {
    const credential = parseWorkBuddyAuth(JSON.stringify({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: 0,
      domain: '',
      uid: 'uid-2',
    }))
    expect(credential?.accessToken).toBe('at')
    expect(credential?.uid).toBe('uid-2')
    expect(credential?.expiresAtMs).toBe(0)
  })

  it('rejects documents without an access token', () => {
    expect(parseWorkBuddyAuth('{}')).toBeUndefined()
    expect(parseWorkBuddyAuth('not json')).toBeUndefined()
    expect(parseWorkBuddyAuth(JSON.stringify({ auth: { refreshToken: 'rt' } }))).toBeUndefined()
  })
})

function credentialWith(expiresAtMs: number): WorkBuddyCredential {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAtMs,
    domain: 'www.codebuddy.cn',
    uid: 'uid-1',
    source: 'desktop',
  }
}

describe('WorkBuddyCredentialStore', () => {
  it('serves a fresh desktop credential without refreshing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 3600_000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'new' }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    expect(refreshes).toBe(0)
  })

  it('refreshes an expiring credential, persists the copy, and serves it next', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    const own = join(dir, 'own.json')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh', source: 'dsh' })
    const saved = JSON.parse(await readFile(own, 'utf8')) as { version: number, credential: { accessToken: string } }
    expect(saved.version).toBe(1)
    expect(saved.credential.accessToken).toBe('fresh')
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh' })
    // 副本读回时必须带正确的过期时间:字段名不对称曾让副本读回
    // expiresAtMs=0、needsRefresh 恒真,第二次 resolve 仍会刷新。
    expect(refreshes).toBe(1)
  })

  it('still returns a not-yet-expired token when refresh fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 60_000))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refreshMarginMs: 5 * 60_000,
      refresh: async () => {
        throw new Error('refresh endpoint down')
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
  })

  it('fast-fails an expired token inside the refresh-failure backoff window, then retries after it', async () => {
    // 过期侧退避回归:节流窗口此前只对未过期 token 生效,刷新端点故障 +
    // token 已过期的组合下,每条请求都会串行等一次刷新失败。失败后的窗口内
    // 必须快速失败,窗口过后才允许再次尝试。
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        throw new Error('refresh endpoint down')
      },
    })
    // 第一次:token 已过期,尝试刷新并失败(异常上抛)。
    await expect(store.resolve()).rejects.toThrow(/token refresh failed and the access token is expired/)
    expect(refreshes).toBe(1)
    // 退避窗口内:快速失败,不再打刷新端点。
    await expect(store.resolve()).rejects.toThrow(/refresh failed recently/)
    expect(refreshes).toBe(1)
    // 窗口过后:允许再试(再次失败同样上抛)。
    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 31_000)
      await expect(store.resolve()).rejects.toThrow(/token refresh failed and the access token is expired/)
      expect(refreshes).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails loudly when nothing is signed in', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(dir, 'missing.info'),
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.resolve()).rejects.toThrow(/no signed-in WorkBuddy account/)
  })

  it('keeps a refreshed token in memory when saving the owned copy fails', async () => {
    // H4 回归:上游可能把 refresh token 轮换为一次性新值,落盘失败时若退回
    // 磁盘旧副本,下一次刷新必然 session_dead;刷新成果必须保留在内存里,
    // 且告警要说清是「落盘失败」而非「上游刷新失败」。
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    // ownPath 落在普通文件之下:withFileLock 建锁文件即失败(ENOTDIR),
    // 原子写必然走不出去;logout 的 force rm 对不存在路径无害。
    const own = join(dir, 'plain-file', 'own.json')
    await writeFile(join(dir, 'plain-file'), 'x')
    const warnings: string[] = []
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: own,
      onWarning: message => warnings.push(message),
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'fresh', refreshToken: 'rt2', expiresInSec: 3600 }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh', refreshToken: 'rt2' })
    expect(warnings.some(w => w.includes('saving the plugin-owned copy failed')), '告警报告落盘失败').toBe(true)
    expect(await readFile(own, 'utf8').then(() => true, () => false), '目录路径不产生副本文件').toBe(false)
    // 内存兜底生效:后续请求不再刷新(也不丢轮换后的 refresh token)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh' })
    expect(refreshes).toBe(1)
  })

  it('does not re-refresh on every request when the upstream omits expiresIn', async () => {
    // H5 回归:缺 expiresIn 时沿用旧过期时间会让 needsRefresh 恒真,
    // 每条请求都打一次刷新端点;必须按保守下限外推。
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        return { accessToken: 'fresh' }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh' })
    const served = await store.resolve()
    expect(served.accessToken).toBe('fresh')
    expect(refreshes).toBe(1)
    expect(served.expiresAtMs).toBeGreaterThan(Date.now() + 60_000)
  })

  it('throttles refreshes for very short-lived tokens within the window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() - 1000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        return { accessToken: `fresh-${refreshes}`, expiresInSec: 5 }
      },
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh-1' })
    // token 未过期 + 30s 节流窗口内:不再次刷新
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'fresh-1' })
    expect(refreshes).toBe(1)
  })

  it('throttles refresh attempts when the refresh endpoint keeps failing', async () => {
    // 失败侧回归:token 在 margin 内(还剩 4 分钟)但刷新端点持续故障时,
    // 失败也必须计入节流窗口——否则每条请求都会打一次刷新端点(与「极短
    // 有效期打爆端点」同构,只是发生在失败侧)。
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop.info')
    await writeFile(desktop, nestedDoc(Date.now() + 240_000))
    let refreshes = 0
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => {
        refreshes += 1
        throw new Error('refresh endpoint down')
      },
    })
    // 首次:尝试刷新,失败但 token 仍可复用(>30s 寿命)。
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    expect(refreshes).toBe(1)
    // 30s 节流窗口内:不再尝试,直接返回现值。
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    expect(refreshes).toBe(1)
  })

  it('applies a desktop-path repoint on the next read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const first = join(dir, 'workbuddy-a.info')
    const second = join(dir, 'workbuddy-b.info')
    await writeFile(first, nestedDoc(Date.now() + 3600_000))
    await writeFile(second, JSON.stringify({
      auth: { accessToken: 'at-b', refreshToken: 'rt', expiresAt: Date.now() + 7200_000, domain: '' },
      account: { uid: 'uid-b', nickname: 'B' },
    }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: first,
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at' })
    store.setDesktopPath(second)
    expect(store.desktopAuthPath()).toBe(second)
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-b', nickname: 'B' })
  })

  it('treats a blank authFile repoint as no override and returns to platform probing', async () => {
    // 回归：settings 文档把未设置的 authFile 物化成空串，onChange 会把它原样
    // 传给 setDesktopPath——空串曾把探测路径钉死为单个空路径，插件整体变成
    // signed-out，设置页卡片因此消失。
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const store = new WorkBuddyCredentialStore({
      desktopPath: join(dir, 'explicit.info'),
      ownPath: join(dir, 'own.json'),
      refresh: async credential => ({ accessToken: credential.accessToken }),
    })
    store.setDesktopPath('')
    expect(store.desktopAuthPath()).toBe(defaultDesktopAuthCandidates()[0])
    expect(store.desktopAuthPath()).not.toBe('')
    store.setDesktopPath('   ')
    expect(store.desktopAuthPath()).toBe(defaultDesktopAuthCandidates()[0])
  })
})

describe('Windows default desktop path probing', () => {
  function windowsDoc(token: string): string {
    return JSON.stringify({
      auth: { accessToken: token, refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
      account: { uid: 'uid-w', nickname: 'Win 用户' },
    })
  }

  /** Fake a win32 home; probes are mocked in, dirs under a temp root. */
  async function fakeWindowsHome(): Promise<{ home: string, local: string, roaming: string }> {
    const home = await mkdtemp(join(tmpdir(), 'wb-win-'))
    CLEANUP.push(() => rm(home, { recursive: true, force: true }))
    const local = join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    const roaming = join(home, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')
    return { home, local, roaming }
  }

  /** Run the case body as win32 with the given home; restore on exit. */
  async function asWindows<T>(home: string, run: () => Promise<T>): Promise<T> {
    const savedPlatform = process.platform
    const savedEnv = process.env[WORKBUDDY_AUTH_FILE_ENV]
    delete process.env[WORKBUDDY_AUTH_FILE_ENV]
    fakeOs.home = home
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      return await run()
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
      fakeOs.home = undefined
      if (savedEnv === undefined) delete process.env[WORKBUDDY_AUTH_FILE_ENV]
      else process.env[WORKBUDDY_AUTH_FILE_ENV] = savedEnv
    }
  }

  it('lists Local before Roaming on win32', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await asWindows(home, async () => {
      const candidates = defaultDesktopAuthCandidates()
      expect(candidates).toEqual([local, roaming])
    })
  })

  it('reads the Local AppData file when only it exists', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-local', source: 'desktop' })
      await expect(store.desktopFilePresent()).resolves.toBe(true)
    })
  })

  it('falls back to Roaming when only it exists (older desktop builds)', async () => {
    const { home, roaming } = await fakeWindowsHome()
    await mkdir(join(roaming, '..'), { recursive: true })
    await writeFile(roaming, windowsDoc('at-roaming'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-roaming', source: 'desktop' })
      await expect(store.desktopFilePresent()).resolves.toBe(true)
    })
  })

  it('prefers Local when both exist', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await mkdir(join(local, '..'), { recursive: true })
    await mkdir(join(roaming, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await writeFile(roaming, windowsDoc('at-roaming'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-local' })
    })
  })

  it('reports signed-out and lists both candidates when neither exists', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.status()).resolves.toMatchObject({ state: 'signed-out' })
      await expect(store.desktopFilePresent()).resolves.toBe(false)
      await expect(store.resolve()).rejects.toThrow(new RegExp(local.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)))
      await expect(store.resolve()).rejects.toThrow(/AppData.*Local[\s\S]*AppData.*Roaming/)
    })
  })

  it('uses an explicit desktopPath verbatim without probing on win32', async () => {
    const { home, local, roaming } = await fakeWindowsHome()
    const explicit = join(home, 'explicit.info')
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, windowsDoc('at-local'))
    await writeFile(explicit, windowsDoc('at-explicit'))
    await asWindows(home, async () => {
      const store = new WorkBuddyCredentialStore({
        desktopPath: explicit,
        ownPath: join(home, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at-explicit' })
      expect(store.desktopAuthPath()).toBe(explicit)
      void roaming
    })
  })
})

describe('WSL default desktop path probing', () => {
  const AUTH_TAIL = join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info')

  async function asWsl<T>(options: {
    home: string
    env?: Partial<Record<'APPDATA' | 'LOCALAPPDATA' | 'USERPROFILE', string>>
  }, run: () => Promise<T>): Promise<T> {
    const savedPlatform = process.platform
    const savedEnv = Object.fromEntries(
      ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'WSL_DISTRO_NAME', 'WSL_INTEROP']
        .map(name => [name, process.env[name]]),
    )
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    fakeOs.home = options.home
    fakeOs.release = '6.6.87.2-microsoft-standard-WSL2'
    delete process.env['APPDATA']
    delete process.env['LOCALAPPDATA']
    delete process.env['USERPROFILE']
    delete process.env['WSL_DISTRO_NAME']
    delete process.env['WSL_INTEROP']
    Object.assign(process.env, options.env)
    try {
      return await run()
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
      fakeOs.home = undefined
      fakeOs.release = undefined
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  it('probes the matching mounted Windows profile before the Linux path', async () => {
    await asWsl({ home: '/home/alice' }, async () => {
      expect(defaultDesktopAuthCandidates()).toEqual([
        join('/mnt/c/Users/alice/AppData/Local', AUTH_TAIL),
        join('/mnt/c/Users/alice/AppData/Roaming', AUTH_TAIL),
        join('/home/alice/.config', AUTH_TAIL),
      ])
    })
  })

  it('uses translated WSL environment paths when the Windows user differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wb-wsl-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const windowsProfile = join(root, 'Users', 'windows-alice')
    const local = join(windowsProfile, 'AppData', 'Local', AUTH_TAIL)
    await mkdir(join(local, '..'), { recursive: true })
    await writeFile(local, nestedDoc(Date.now() + 3600_000))

    await asWsl({ home: '/home/linux-alice', env: { USERPROFILE: windowsProfile } }, async () => {
      const store = new WorkBuddyCredentialStore({
        ownPath: join(root, 'own.json'),
        refresh: async credential => ({ accessToken: credential.accessToken }),
      })
      expect(store.desktopAuthPath()).toBe(local)
      await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'at', source: 'desktop' })
    })
  })

  it('converts Windows-form AppData environment paths to WSL mount paths', async () => {
    await asWsl({
      home: '/home/alice',
      env: {
        LOCALAPPDATA: String.raw`D:\Users\alice\AppData\Local`,
        APPDATA: String.raw`D:\Users\alice\AppData\Roaming`,
      },
    }, async () => {
      expect(defaultDesktopAuthCandidates().slice(0, 2)).toEqual([
        join('/mnt/d/Users/alice/AppData/Local', AUTH_TAIL),
        join('/mnt/d/Users/alice/AppData/Roaming', AUTH_TAIL),
      ])
    })
  })
})

describe('WorkBuddyCredentialStore variants', () => {
  function aiDoc(expiresAt: number): string {
    return JSON.stringify({
      auth: { accessToken: 'ai-at', refreshToken: 'ai-rt', expiresAt, domain: 'www.workbuddy.ai' },
      account: { uid: 'ai-uid', nickname: 'AI 用户' },
    })
  }

  it('serves the AI desktop file from a variant store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-ai-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop-ai.info')
    await writeFile(desktop, aiDoc(Date.now() + 3600_000))
    const { AI_VARIANT } = await import('../src/variants.js')
    const store = new WorkBuddyCredentialStore({
      variant: AI_VARIANT,
      desktopPath: desktop,
      ownPath: join(dir, 'own-ai.json'),
      refresh: async () => ({ accessToken: 'new' }),
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'ai-at', source: 'desktop' })
  })

  it('refuses a CN credential in the AI variant with a fixable error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-region-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop-ai.info')
    await writeFile(desktop, nestedDoc(Date.now() + 3600_000))
    const { AI_VARIANT } = await import('../src/variants.js')
    const { RegionMismatchError } = await import('../src/auth.js')
    const store = new WorkBuddyCredentialStore({
      variant: AI_VARIANT,
      desktopPath: desktop,
      ownPath: join(dir, 'own-ai.json'),
      refresh: async () => ({ accessToken: 'new' }),
    })
    await expect(store.current()).rejects.toBeInstanceOf(RegionMismatchError)
    await expect(store.current()).rejects.toThrow('WORKBUDDY_AI_AUTH_FILE')
    // status() reports signed-out with the reason rather than throwing.
    const status = await store.status()
    expect(status.state).toBe('signed-out')
    expect(status.reason).toContain('WORKBUDDY_AI_AUTH_FILE')
  })

  it('leaves variant-less stores unguarded for backward compatibility', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-store-legacy-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    const desktop = join(dir, 'workbuddy-desktop-ai.info')
    await writeFile(desktop, aiDoc(Date.now() + 3600_000))
    const store = new WorkBuddyCredentialStore({
      desktopPath: desktop,
      ownPath: join(dir, 'own.json'),
      refresh: async () => ({ accessToken: 'new' }),
    })
    await expect(store.resolve()).resolves.toMatchObject({ accessToken: 'ai-at' })
  })
})
