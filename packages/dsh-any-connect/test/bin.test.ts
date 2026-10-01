import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/bin.js'
import { deriveProtectorKey, sealAuthFieldForTest } from '../src/desktop-credential-protection.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('dsh-any-connect CLI --provider', () => {
  it('rejects an unknown provider naming the valid ids', async () => {
    const err: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--provider', 'nope'])).toBe(1)
      expect(err.join('')).toContain('workbuddy-ai')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports the AI variant signed out against an empty home', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'no-such-ai-file.info'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'no-such-file.info'))
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--provider=workbuddy-ai'])).toBe(1)
      expect(out.join('')).toContain('signed out')
    } finally {
      spy.mockRestore()
    }
  })

  // POSIX 假 helper:被测代码用 execFile 直接执行它,不需要 Electron。Windows
  // 上没有可直接执行的无扩展名脚本,该用例按平台跳过(与模块内的平台判定一致)。
  it.skipIf(process.platform === 'win32')('doctor unlocks a 5.6 encrypted credential through the helper and reports it', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    const secret = Buffer.alloc(32, 11).toString('base64')
    const key = deriveProtectorKey(secret)
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, JSON.stringify({
      auth: {
        accessToken: sealAuthFieldForTest(key, 'cli-access-token'),
        refreshToken: sealAuthFieldForTest(key, 'cli-refresh-token'),
        expiresAt: Date.now() + 3_600_000,
        domain: 'www.codebuddy.cn',
      },
      account: { uid: 'uid-cli', nickname: 'CLI' },
    }))
    const helper = join(root, 'fake-workbuddy-electron')
    await writeFile(helper, `#!/bin/sh
printf '%s' '${JSON.stringify({ version: 1, atRestSecretKey: secret })}'
`, { mode: 0o755 })
    vi.stubEnv('WORKBUDDY_AUTH_FILE', desktop)
    vi.stubEnv('WORKBUDDY_ELECTRON_BIN', helper)
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['doctor', '--json'])).toBe(0)
      const report = JSON.parse(out.join('')) as Record<string, unknown>
      expect(report['signIn']).toBe('signed-in')
      expect((report['desktopAuthFile'] as Record<string, unknown>)['format']).toBe('encrypted')
      expect(report['atRestHelper']).toBe(helper)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the default provider CN when --provider is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'no-such-file.info'))
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status'])).toBe(1)
      expect(out.join('')).toContain('WorkBuddy Connect: signed out')
    } finally {
      spy.mockRestore()
    }
  })
})
