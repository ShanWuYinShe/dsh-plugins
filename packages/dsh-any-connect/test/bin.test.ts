import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { humanCredits, run } from '../src/bin.js'
import { deriveProtectorKey, sealAuthFieldForTest } from '../src/desktop-credential-protection.js'
import { ZCODE_START_PLAN_VARIANT, ZCODE_VARIANT } from '../src/variants.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('humanCredits 空窗口文案按产品区分', () => {
  it('Coding Plan 的空窗口不得输出 Start Plan 领取文案', () => {
    // AC-17：Coding Plan 没有「每日领取」这回事，把 Start Plan 的
    // "claim it in the ZCode client" 打给它是错误动作指引。
    const text = humanCredits(ZCODE_VARIANT, { total: 0 }, [])
    expect(text).toContain('Coding Plan quota')
    expect(text).not.toContain('Start Plan')
    expect(text).not.toContain('claim')
  })

  it('Start Plan 的空窗口保留领取文案（那是它真实存在的动作）', () => {
    const text = humanCredits(ZCODE_START_PLAN_VARIANT, { total: 0 }, [])
    expect(text).toContain('Start Plan quota')
    expect(text).toContain('claim it in the ZCode client')
  })

  it('WorkBuddy 仍按积分总数报，不套 ZCode 窗口文案', () => {
    const text = humanCredits({ id: 'workbuddy', kind: 'workbuddy' } as never, { total: 42 }, [])
    expect(text).toBe('Remaining credit: 42')
  })
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

  // Start Plan 的额度口径与 WorkBuddy 点数不同:total 是当日 token 池的数字,
  // 人读行必须照 pill 的语义写(带单位与上限),而不是裸的 credits 计数。
  it.skipIf(process.platform === 'win32')('reports Start Plan quota as a token pool, not a credit count', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    const credPath = join(root, 'zcode-credentials.json')
    await writeFile(credPath, JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'id.secret',
      zcodejwttoken: 'cli-jwt',
    }))
    vi.stubEnv('ZCODE_AUTH_FILE', credPath)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        plans: [{ name: 'ZCode Trust Build', plan_id: 'p1', ends_at: Math.floor(Date.now() / 1000) + 3600 }],
        balances: [{ show_name: 'GLM-5.3-Flash', plan_id: 'p1', total_units: 100000000, remaining_units: 57798755, expires_at: Math.floor(Date.now() / 1000) + 7200 }],
      },
    }), { status: 200 })))
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--json', '--provider', 'zcode-start-plan'])).toBe(0)
      const report = JSON.parse(out.join('')) as { credits?: number; quotaWindows?: Array<{ unit?: string; remain?: number; limit?: number }> }
      // --json:窗口带真实 token 数字(与 pill 同口径),不再是裸 total。
      expect(report.quotaWindows?.[0]).toMatchObject({ unit: 'tokens', remain: 57798755, limit: 100000000 })
      // C-8：ZCode 的 JSON 不再给兼容字段 credits.total（额度语义是窗口）。
      expect((report as { credits?: number }).credits).toBeUndefined()
      // 人读模式:带单位与上限,而不是「Remaining credit: 57798755」。
      out.length = 0
      expect(await run(['status', '--provider', 'zcode-start-plan'])).toBe(0)
      expect(out.join('')).toMatch(/Start Plan quota: [\d,]+ \/ [\d,]+ tokens/)
    } finally {
      spy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  // 2026-10-24 实测（"ZCode 1024 Dev Day"）：上游把一个活动按模型分池，
  // balances 里每个模型一个 bucket 且互不通用。CLI 的 --json 与人读输出都要
  // 每池一条，只报第一个池会丢掉另一个模型整整一份额度。
  it.skipIf(process.platform === 'win32')('reports one window per Start Plan model pool', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    const credPath = join(root, 'zcode-credentials.json')
    await writeFile(credPath, JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'id.secret',
      zcodejwttoken: 'cli-jwt',
    }))
    vi.stubEnv('ZCODE_AUTH_FILE', credPath)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: {
        plans: [{ name: 'ZCode 1024 Dev Day', plan_id: 'p1', ends_at: Math.floor(Date.now() / 1000) + 3600 }],
        balances: [
          { show_name: 'GLM-5.3-Flash', plan_id: 'p1', total_units: 300000000, remaining_units: 299141650, expires_at: Math.floor(Date.now() / 1000) + 7200 },
          { show_name: 'GLM-5.3', plan_id: 'p1', total_units: 200000000, remaining_units: 200000000, expires_at: Math.floor(Date.now() / 1000) + 7200 },
        ],
      },
    }), { status: 200 })))
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--json', '--provider', 'zcode-start-plan'])).toBe(0)
      const report = JSON.parse(out.join('')) as { quotaWindows?: Array<{ id?: string; label?: string; remain?: number; limit?: number; resetsAt?: string }> }
      // expires_at 相对当前时刻，窗口必然带动态 resetsAt——按项匹配数字与标识。
      expect(report.quotaWindows).toHaveLength(2)
      expect(report.quotaWindows?.[0]).toMatchObject({ id: 'plan:glm-5.3-flash', label: 'GLM-5.3-Flash', remain: 299141650, limit: 300000000, unit: 'tokens' })
      expect(report.quotaWindows?.[1]).toMatchObject({ id: 'plan:glm-5.3', label: 'GLM-5.3', remain: 200000000, limit: 200000000, unit: 'tokens' })
      expect(typeof report.quotaWindows?.[0]?.resetsAt).toBe('string')
      // 人读模式:每池一行,各自带模型名与上限。
      out.length = 0
      expect(await run(['status', '--provider', 'zcode-start-plan'])).toBe(0)
      const lines = out.join('').split('\n').filter(line => line.includes('Start Plan quota:'))
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(/Start Plan quota: 299,141,650 \/ 300,000,000 tokens \(GLM-5\.3-Flash\)/)
      expect(lines[1]).toMatch(/Start Plan quota: 200,000,000 \/ 200,000,000 tokens \(GLM-5\.3\)/)
    } finally {
      spy.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
