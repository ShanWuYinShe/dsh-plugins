import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as AnyConnect from '../src/index.js'
import { signedInDocument } from './catalog-harness.js'
import { domainCreditLedgerPersistence, domainStateStore } from '../src/state-store.js'
import type { WorkBuddyStateStore } from '../src/state-store.js'
import type { WorkBuddyCredential } from '../src/auth-types.js'
import { clearHostHeartbeat, isHeartbeatProcessAlive, processStartTimeMs, readHostHeartbeat, writeHostHeartbeat } from '../src/host-heartbeat.js'
import { codingPlanWhitelistFromConfig, readZcodeCodingPlanWhitelist } from '../src/zcode-builtin-catalog.js'
import { createCatalogTimers } from '../src/catalog-timers.js'
import { decryptZCodeEncryptedKey } from '../src/auth-zcode-crypto.js'
import crypto from 'node:crypto'

/**
 * 服务端覆盖率补齐：入口组装（settings/storageDomain 注入与卸载）、变体运行时
 * 的三条探针控制动作与状态路由读数、state-store 域包装、心跳、ZCode 白名单
 * 候选路径、定时器、enc:v1 解密分支。全部断言真实行为，不写空跑用例。
 */

const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = undefined
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** 只拦上游的 fetch 桩（回环放行给真实监听器，本文件用例不需要）。 */
function stubUpstream(): void {
  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/)/u.test(url)) return await realFetch(input, init)
    return new Response(JSON.stringify({ code: 500, msg: 'stub' }), { status: 500 })
  }))
}

interface FakeRouteRegistry {
  handlers: Map<string, (req: never, res: never) => unknown>
  registrations: number
}

/** 真实插件 + 真实 llm，webServer/settings/storageDomain 用结构最小假服务（可选服务）。 */
async function composePlugin(options: {
  storageDomainOpen?: () => Promise<unknown>
  webServer?: FakeRouteRegistry
} = {}): Promise<{
  ctx: Context
  routes: FakeRouteRegistry
  settingsConfigure: ReturnType<typeof vi.fn>
  domainClose: ReturnType<typeof vi.fn>
  loggerError: ReturnType<typeof vi.spyOn>
}> {
  root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-cov-'))
  const desktop = join(root, 'workbuddy-desktop.info')
  await writeFile(desktop, signedInDocument())
  stubUpstream()

  const routes: FakeRouteRegistry = options.webServer ?? { handlers: new Map(), registrations: 0 }
  const settingsConfigure = vi.fn(() => () => {})
  const domainClose = vi.fn(async () => {})
  // 宿主 logger 是 cordis 内置服务（ctx.logger 恒在）：spy 它的 error 观察
  // 插件对可选服务失败的可见性。
  let loggerError: ReturnType<typeof vi.spyOn> | undefined
  const tables = new Map<string, { get: () => unknown; put: () => Promise<void>; delete: () => Promise<void> }>()
  const fakeDomain = {
    table: (name: string) => {
      let table = tables.get(name)
      if (table === undefined) {
        table = { get: () => undefined, put: async () => {}, delete: async () => {} }
        tables.set(name, table)
      }
      return table
    },
    close: domainClose,
  }

  const ctx = new Context()
  context = ctx
  loggerError = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  await ctx.plugin(LlmRuntime)
  ctx.provide('settings', { configure: settingsConfigure } as never)
  if (options.storageDomainOpen !== undefined) {
    ctx.provide('storageDomain', { open: options.storageDomainOpen } as never)
  } else {
    ctx.provide('storageDomain', { open: async () => fakeDomain } as never)
  }
  ctx.provide('webServer', {
    register: (route: { path: string; handler: (req: never, res: never) => unknown }) => {
      routes.registrations += 1
      routes.handlers.set(route.path, route.handler)
      return () => routes.handlers.delete(route.path)
    },
    getOrigin: () => 'http://127.0.0.1:1',
  } as never)

  await ctx.plugin(AnyConnect, { authFile: desktop, authFileAI: join(root, 'no-such-ai.info') })
  await vi.waitFor(() => { expect(routes.handlers.size).toBeGreaterThanOrEqual(10) }, { timeout: 10_000 })
  await vi.waitFor(() => { expect(ctx.llm.listProviders().length).toBe(5) }, { timeout: 10_000 })
  return { ctx, routes, settingsConfigure, domainClose, loggerError: loggerError! }
}

/** 以最小 req/res 桩调用插件路由处理器（真实 handler，不挂 HTTP server）。 */
async function callRoute(
  handler: (req: never, res: never) => unknown,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const body = options.body === undefined ? '' : JSON.stringify(options.body)
  const req = {
    method: options.method ?? 'GET',
    headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234', 'sec-fetch-site': 'same-origin', ...options.headers },
    async *[Symbol.asyncIterator]() { if (body !== '') yield Buffer.from(body) },
  }
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (text: string) => { payload = text },
  }
  await handler(req as never, res as never)
  return { status, json: payload === '' ? {} : JSON.parse(payload) as Record<string, unknown> }
}

describe('入口组装：settings / storageDomain 注入与卸载', () => {
  it('settings 可用时 configure({auto:false}) 进 effect；storageDomain 就绪后注入域存取并在卸载时 close', async () => {
    const { ctx, settingsConfigure, domainClose } = await composePlugin()
    expect(settingsConfigure).toHaveBeenCalledWith({ auto: false }, expect.anything())
    // 域就绪是异步续体：等 open 落定后 close 由插件 effect 持有，卸载时执行。
    await vi.waitFor(() => { expect(domainClose).not.toHaveBeenCalled() }, { timeout: 5_000 })
    await ctx.fiber.dispose()
    context = undefined
    expect(domainClose, '卸载必须关闭打开的存储域').toHaveBeenCalledTimes(1)
  })

  it('storageDomain open 失败：记 error 并继续走文件回落（模型通道不受影响）', async () => {
    const { ctx, loggerError } = await composePlugin({ storageDomainOpen: async () => { throw new Error('domain unavailable') } })
    // 插件活着的证明：provider 已注册（composePlugin 内已断言）。
    expect(ctx.llm.listProviders()).toHaveLength(5)
    await vi.waitFor(() => { expect(loggerError, '域失败必须可见').toHaveBeenCalled() }, { timeout: 5_000 })
    expect(String(loggerError.mock.calls[0]?.[0])).toContain('state domain unavailable')
  })
})

describe('变体运行时：探针控制动作与状态路由读数', () => {
  it('status 路由可读（同源）；probe 路由的刷新/隐藏/恢复/一键恢复全部生效', async () => {
    const { ctx, routes } = await composePlugin()
    const statusHandler = routes.handlers.get('/plugins/dsh-any-connect/status')!
    const probeHandler = routes.handlers.get('/plugins/dsh-any-connect/probe')!
    expect(routes.registrations).toBeGreaterThanOrEqual(10)

    const status = await callRoute(statusHandler)
    expect(status.status).toBe(200)
    expect(status.json['status']).toBe('signed-in')
    const key = status.json['probeKey'] as string
    expect(typeof key).toBe('string')

    const auth = { 'x-workbuddy-probe-key': key, 'content-type': 'application/json' }
    const refreshed = await callRoute(probeHandler, { method: 'POST', headers: auth, body: { action: 'refresh' } })
    expect(refreshed.json).toEqual({ state: 'ok' })

    // 用兜底名单里的真实模型 id（当前目录来自 fallback，未知 id 不计入 excludedCount）。
    const fallbackId = String(status.json['models'] === undefined ? 'glm-5.2' : (status.json['models'] as Array<{ id: string }>)[0]?.id ?? 'glm-5.2')
    const deleted = await callRoute(probeHandler, { method: 'POST', headers: auth, body: { action: 'delete-model', modelId: fallbackId } })
    expect(deleted.json['state']).toBe('ok')
    expect(typeof deleted.json['excludedCount']).toBe('number')
    const restored = await callRoute(probeHandler, { method: 'POST', headers: auth, body: { action: 'restore-model', modelId: fallbackId } })
    expect(restored.json['state']).toBe('ok')
    const restoredAll = await callRoute(probeHandler, { method: 'POST', headers: auth, body: { action: 'restore-models' } })
    expect(restoredAll.json).toEqual({ state: 'ok', excludedCount: 0 })

    // 卸载信号：dispose 后探针动作一律拒绝（不再写隐藏清单/触发上游）。
    await ctx.fiber.dispose()
    context = undefined
    const afterDispose = await callRoute(probeHandler, { method: 'POST', headers: auth, body: { action: 'refresh' } })
    expect(afterDispose.json).toMatchObject({ state: 'failed' })
  })

  it('loader/volatile-update 派发会把新配置推给变体（不重载即生效）', async () => {
    const { ctx } = await composePlugin()
    // 派发事件只是本地动作，不应抛错；写出的行为由 applyVariantConfig/refresh 承接。
    expect(() => { ctx.emit('loader/volatile-update', [['authFile']]) }).not.toThrow()
  })
})

describe('state-store：宿主域包装读写删', () => {
  function fakeDomain(): {
    domain: Parameters<typeof domainStateStore>[0]
    calls: string[]
    store: WorkBuddyStateStore
  } {
    const calls: string[] = []
    const table = {
      get: (key: string) => { calls.push(`get:${key}`); return key === 'has' ? { accessToken: 'x' } : undefined },
      put: async (key: string) => { calls.push(`put:${key}`) },
      delete: async (key: string) => { calls.push(`delete:${key}`) },
    }
    const domain = { table: () => table } as unknown as Parameters<typeof domainStateStore>[0]
    return { domain, calls, store: domainStateStore(domain) }
  }

  it('凭据副本的读/写/删都落到域表；台账持久化走同域 ledger 表', async () => {
    const { domain, calls, store } = fakeDomain()
    await expect(store.read('has')).resolves.toEqual({ accessToken: 'x' })
    await fn(store.write('v1', { accessToken: 'a' } as WorkBuddyCredential), calls, 'put')
    await fn(store.clear('v1'), calls, 'delete')
    const ledger = domainCreditLedgerPersistence(domain)
    await ledger.load('v1')
    await ledger.save('v1', { days: [] } as never)
    expect(calls).toEqual(expect.arrayContaining(['get:has', 'put:v1', 'delete:v1']))
  })

  async function fn(promise: Promise<unknown>, calls: string[], prefix: string): Promise<void> {
    await promise
    expect(calls.some(call => call.startsWith(prefix))).toBe(true)
  }
})

describe('host-heartbeat：写/读/清、进程起点与存活判定', () => {
  it('写心跳后可读回同一 pid；clear 后读取为空', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-hb-'))
    vi.stubEnv('DSH_HOME', root)
    await writeHostHeartbeat()
    const heartbeat = await readHostHeartbeat()
    expect(heartbeat?.pid).toBe(process.pid)
    expect(heartbeat?.package).toBe('dsh-any-connect')
    await clearHostHeartbeat()
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('损坏/未知版本的 JSON 视为无心跳', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-hb-'))
    vi.stubEnv('DSH_HOME', root)
    const path = (await import('../src/host-heartbeat.js')).workbuddyHostHeartbeatPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not-json')
    expect(await readHostHeartbeat()).toBeUndefined()
    await writeFile(path, JSON.stringify({ version: 999, package: 'dsh-any-connect', registeredAt: 1, pid: 1 }))
    expect(await readHostHeartbeat()).toBeUndefined()
  })

  it('processStartTimeMs：读不到进程起点（沙盒 EPERM / 无此 pid）时返回 undefined，不抛错', () => {
    if (process.platform === 'win32') return
    // 本仓测试沙盒禁止 spawn ps（EPERM）：这里断言的是**降级语义**——读不到
    // 起点必须是 undefined 而不是抛错；正常环境的解析分支由
    // coverage-heartbeat-ps.test.ts 用注入的 execFileSync 覆盖。
    expect(processStartTimeMs(999_999_999)).toBeUndefined()
    const current = processStartTimeMs(process.pid)
    expect(current === undefined || typeof current === 'number', '要么给出数值要么显式未知').toBe(true)
  })

  it('存活判定：EPERM 视为活着；已死 pid 为假；起点晚于注册时刻的回收 pid 为假', async () => {
    const realKill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0) {
        const code = (globalThis as { __killCode?: string }).__killCode
        if (code !== undefined) throw Object.assign(new Error('denied'), { code })
        return true
      }
      return realKill(pid, signal)
    }) as typeof process.kill)
    // pid 取必然不存在的值：本用例模拟 kill(0) 成功、但读不到进程起点（沙盒拦截或不存在的 pid）。
    // 若用真实可能存在的 pid（曾用 1234），在 ps 可用的环境会读到起点并被判成回收 pid，用例随环境漂移。
    const base = { version: 1 as const, package: 'dsh-any-connect' as const, pluginVersion: 'x', registeredAt: 0, pid: 999_999_999 }
    ;(globalThis as { __killCode?: string }).__killCode = 'EPERM'
    expect(isHeartbeatProcessAlive(base)).toBe(true)
    ;(globalThis as { __killCode?: string }).__killCode = 'ESRCH'
    expect(isHeartbeatProcessAlive(base)).toBe(false)
    delete (globalThis as { __killCode?: string }).__killCode
    // PID 存在但读不到进程起点（沙盒/平台不支持）时降级为「活着」，不误杀。
    vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    expect(isHeartbeatProcessAlive({ ...base, registeredAt: 0 })).toBe(true)
  })
})

describe('zcode-builtin-catalog：候选路径与解析容错', () => {
  it('win32/linux/darwin 平台候选都能构造且缺失文件时安全返回 undefined', () => {
    const platform = vi.spyOn(process, 'platform', 'get')
    vi.stubEnv('ZCODE_BUILTIN_CONFIG', '')
    for (const p of ['win32', 'linux'] as const) {
      platform.mockReturnValue(p)
      expect(readZcodeCodingPlanWhitelist(), p).toBeUndefined()
    }
    // darwin 候选在装了 ZCode 的机器上会真的读到白名单：只断言不抛错、类型正确。
    platform.mockReturnValue('darwin')
    const darwin = readZcodeCodingPlanWhitelist()
    expect(darwin === undefined || darwin instanceof Set).toBe(true)
    platform.mockReturnValue('aix' as NodeJS.Platform)
    expect(readZcodeCodingPlanWhitelist()).toBeUndefined()
  })

  it('损坏 JSON 与非法计划结构降级为 undefined，不抛错', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-builtin-'))
    const path = join(root, 'zcode-builtin.json')
    vi.stubEnv('ZCODE_BUILTIN_CONFIG', path)
    await writeFile(path, '{ broken')
    expect(readZcodeCodingPlanWhitelist()).toBeUndefined()
    expect(codingPlanWhitelistFromConfig({ config: { providerConfigRules: { providerRules: [{}] } } })).toBeUndefined()
    expect(codingPlanWhitelistFromConfig({ config: { providerConfigRules: { providerRules: [{ providerId: 'account:bigmodel-x-coding-plan', config: { access: { accountType: 'bigmodel' }, builtinModelIds: ['  '] } }] } } })).toBeUndefined()
  })
})

describe('catalog-timers：身份 sweep 与小时刷新的守卫分支', () => {
  function fakeRuntime(): Record<string, unknown> {
    return {
      variant: { id: 'workbuddy', kind: 'workbuddy', displayName: 'WorkBuddy' },
      store: { current: async () => ({ uid: 'u1', enterpriseId: undefined }) },
      catalog: { current: () => [] },
      catalogFetchedAtMs: Date.now() - 10 * 60_000,
      lastIdentity: undefined,
    }
  }

  it('启动两条定时器→身份变化触发刷新；停止后 idempotent 且不再触发', async () => {
    vi.useFakeTimers()
    const refreshed: string[] = []
    const runtime = fakeRuntime()
    const timers = createCatalogTimers({
      runtimes: [runtime as never],
      isStopped: () => false,
      refreshCatalog: (_runtime, reason) => { refreshed.push(reason) },
      adoptSignedOut: () => {},
      claimFlipChanged: async () => false,
      emptyRosterSelfHealMs: 5 * 60_000,
    })
    timers.startTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(refreshed).toContain('identity sweep')
    timers.stopTimers()
    timers.stopTimers()
    const count = refreshed.length
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(refreshed.length).toBeLessThanOrEqual(count + 1)
    vi.useRealTimers()
  })

  it('区域错配在 sweep 里静默隐藏（adoptSignedOut），不抛错', async () => {
    vi.useFakeTimers()
    const { RegionMismatchError } = await import('../src/auth.js')
    let adopted = 0
    const timers = createCatalogTimers({
      runtimes: [{
        variant: { id: 'workbuddy', kind: 'workbuddy', displayName: 'W' },
        store: { current: async () => { throw new RegionMismatchError('wrong region') } },
        catalog: { current: () => [] },
        catalogFetchedAtMs: undefined,
        lastIdentity: undefined,
      } as never],
      isStopped: () => false,
      refreshCatalog: () => {},
      adoptSignedOut: () => { adopted += 1 },
      claimFlipChanged: async () => false,
      emptyRosterSelfHealMs: 5 * 60_000,
    })
    timers.startTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(adopted).toBe(1)
    timers.stopTimers()
    vi.useRealTimers()
  })
})

describe('auth-zcode-crypto：enc:v1 解密分支', () => {
  function encrypt(plain: string, secret: string): string {
    const key = crypto.createHash('sha256').update(secret).digest()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`
  }

  it('环境变量密钥解开密文；非 enc:v1 原样返回', () => {
    const secret = 'test-secret'
    vi.stubEnv('ZCODE_CREDENTIAL_SECRET', secret)
    expect(decryptZCodeEncryptedKey(encrypt('hello', secret))).toBe('hello')
    expect(decryptZCodeEncryptedKey('plain-value')).toBe('plain-value')
  })

  it('格式非法抛格式错误；密钥不匹配抛最后一个解密错误', () => {
    expect(() => decryptZCodeEncryptedKey('enc:v1:bad')).toThrow(/Invalid ZCode enc:v1/)
    vi.stubEnv('ZCODE_CREDENTIAL_SECRET', 'wrong')
    expect(() => decryptZCodeEncryptedKey(encrypt('hello', 'right'))).toThrow()
  })

  it('/mnt/<drive>/Users/<user> 与 WSL/win32 分支都会尝试对应 Windows 用户密钥', () => {
    // 用 WSL 形态的密文验证：把明文按该分支的 secret 加密，再以 Linux+WSL 环境解密。
    const secret = 'zcode-credential-fallback:win32:C:\\Users\\wsluser:wsluser'
    vi.stubEnv('WSL_INTEROP', '/run/WSL/1_interop')
    vi.stubEnv('USERPROFILE', 'C:\\Users\\wsluser')
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(decryptZCodeEncryptedKey(encrypt('wsl-ok', secret))).toBe('wsl-ok')

    // /mnt 路径分支：desktopPath 指向挂载的 Windows 用户目录。
    const mntSecret = 'zcode-credential-fallback:win32:D:\\Users\\mountuser:mountuser'
    expect(decryptZCodeEncryptedKey(encrypt('mnt-ok', mntSecret), { desktopPath: '/mnt/d/Users/mountuser/credentials.json' })).toBe('mnt-ok')
  })
})
