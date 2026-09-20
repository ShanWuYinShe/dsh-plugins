import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/bin.js'

// CLI 测试与宿主机真实 zcode 登录态隔离：跟随 zcode 的来源恒空，
// 登录态只由 env/文件等测试显式给出。
vi.mock('../src/zcode-credentials.js', () => ({
  readZcodeClientCredentials: async () => undefined,
}))

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

  it('reports the zcode provider signed out against an empty home', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('ZCODE_API_KEY', '')
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--provider=zcode'])).toBe(1)
      expect(out.join('')).toContain('ZCode Connect: signed out')
    } finally {
      spy.mockRestore()
    }
  })

  it('zcode status reports the key source once configured and doctor runs a live check', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('ZCODE_API_KEY', 'abcd1234efgh5678')
    // doctor 的 live check 打桩：CLI 测试不发真实上游请求。
    const zcode = await import('../src/zcode-upstream.js')
    const spy = vi.spyOn(zcode.ZcodeUpstreamClient.prototype, 'forwardMessages')
      .mockImplementation(async () => ({
        ok: true as const,
        status: 200,
        response: new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      }))
    const out: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--provider=zcode'])).toBe(0)
      expect(out.join('')).toContain('key from env')
      out.length = 0
      expect(await run(['doctor', '--provider=zcode', '--json'])).toBe(0)
      const report = JSON.parse(out.join('')) as { keySource: string; keyMasked: string; ping: { ok: boolean } }
      expect(report.keySource).toBe('env')
      expect(report.keyMasked).toBe('abcd••••5678')
      expect(report.ping.ok).toBe(true)
    } finally {
      stdout.mockRestore()
      spy.mockRestore()
    }
  })

  it('logout for the off-peak variant is an honest no-op, not a fake removal', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      // off-peak 凭据完全跟随 zcode 登录态，没有自有副本：不能掉进 WorkBuddy
      // 分支去删一个不存在的文件还声称 removed。
      expect(await run(['logout', '--provider=zcode-offpeak'])).toBe(0)
      const text = out.join('')
      expect(text).not.toContain('removed')
      expect(text).toContain('nothing to remove')
      expect(text).toContain('follow the zcode desktop sign-in')
    } finally {
      spy.mockRestore()
    }
  })
})
