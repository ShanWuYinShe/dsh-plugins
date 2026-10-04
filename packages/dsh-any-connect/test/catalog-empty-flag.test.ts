import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.js'
import type { WorkBuddyModelInfo } from '../src/index.js'
import { workBuddyWebStatus } from '../src/web-status.js'
import type { WorkBuddyStatusRouteOptions } from '../src/web-status.js'

/**
 * 「空名单」必须能与「插件坏了」区分开（task-8 次要项）。
 *
 * 空名单过去在卡片上和故障长得一模一样：source=live、fetchedAt 就是刚才，
 * 却列出 0 个模型。用户填好了凭据、看着「刚刚拉取成功」，却一个模型都没有，
 * 无从判断该等、该重试、还是该去客户端领取。
 *
 * 现在 catalog 带一个显式 empty 标记：拉取**成功但零模型**（Start Plan 今日
 * 未领取）时置位；拉取**失败**（保留旧名单）时不置位——两者互斥。
 */
const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = undefined
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

const CREDENTIAL = {
  accessToken: 'at', refreshToken: 'rt', expiresAtMs: 1234,
  domain: 'www.codebuddy.cn', uid: 'uid-1', source: 'desktop',
} as unknown as Parameters<WorkBuddyStatusRouteOptions['models']> extends never ? never : never

/** 直接组装一份 status 文档：只喂 catalog 形状，不挂路由。 */
async function statusWithCatalog(catalog: WorkBuddyStatusRouteOptions['catalog'] extends () => infer R ? R : never) {
  return await workBuddyWebStatus({
    store: {
      status: async () => ({ state: 'signed-in', expiresAtMs: 1234, nickname: 'tester', source: 'desktop' }),
      current: async () => ({ accessToken: 'at', uid: 'uid-1' }),
    } as never,
    models: () => [],
    catalog: () => catalog,
    probe: () => ({ running: false, results: [] }),
    probeKey: 'test-key',
    path: '/workbuddy-status-empty-test',
  }) as { catalog?: { empty?: true; source: string; error?: string } }
}

describe('空名单的可区分表达', () => {
  it('拉取成功但零模型 → empty 标记；拉取失败 → 不置位（与 error 互斥）', async () => {
    const empty = await statusWithCatalog({ source: 'live', fetchedAt: 1700000000000, empty: true })
    expect(empty.catalog).toEqual({ source: 'live', fetchedAt: 1700000000000, empty: true })

    // 拉取失败：没拉到东西，但那是**故障**，不是「上游说没有」。
    const failed = await statusWithCatalog({ source: 'live', fetchedAt: 1700000000000, error: 'upstream down' })
    expect(failed.catalog?.empty).toBeUndefined()
    expect(failed.catalog?.error).toBe('upstream down')
  })

  /**
   * 真实插件：挂一个假 webServer，从 status 路由读回插件自己组装的 catalog 段。
   *
   * 这是唯一能同时覆盖「catalogEmpty 状态推进」与「catalogSection 把它转成
   * empty 标记」的路径——只测 workBuddyWebStatus 的入参形状会漏掉前者。
   */
  async function readPluginCatalog(modelsImpl: () => Promise<readonly WorkBuddyModelInfo[]>) {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-empty-flag-'))
    const dir = join(root, 'zcode')
    await mkdir(dir, { recursive: true })
    const credentials = join(dir, 'credentials.json')
    await writeFile(credentials, JSON.stringify({
      zcodejwttoken: 'jwt-token',
      device_mid: 'device-1',
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'ind-id.ind-secret',
    }))
    await writeFile(join(dir, 'setting.json'), JSON.stringify({
      providerFamilyDomain: 'bigmodel',
      providerFamilyConnectionSelections: { bigmodel: { kind: 'start-plan' } },
    }))
    let settled = false
    vi.spyOn(WorkBuddy.ZCodeUpstreamClient.prototype, 'fetchModels').mockImplementation(async () => {
      try { return await modelsImpl() } finally { settled = true }
    })
    const catalogSeen = (): boolean => settled

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    // 假 webServer：把每个注册的 handler 记下来，测试直接调用。
    //
    // 用 `ctx.provide(name, value)` 直接挂（与 usage.test.ts 挂 providerUsage 的
    // 写法一致）——这正是让名字对 `ctx.inject`/`ctx.get` 可见的那个 seam。
    // 不包一层 `ctx.plugin({ apply })`：那样既多绕一层，`provide` 也拿不到
    // 本文件的 handlers 闭包。
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
    ctx.provide('webServer', {
      register: (options: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
        handlers.set(options.path, options.handler)
        return () => { handlers.delete(options.path) }
      },
    })
    await ctx.plugin(WorkBuddy, {
      authFile: join(root, 'no-such-file.info'),
      authFileAI: join(root, 'no-such-ai-file.info'),
      authFileZCode: credentials,
    })
    const handler = await vi.waitFor(async () => {
      const found = handlers.get('/plugins/dsh-any-connect/zcode-sp/status')
      expect(found).toBeDefined()
      return found!
    }, { timeout: 5000 })
    // 等启动拉取落定：无论成功还是失败，都要等那一拍**走完**，否则读到的
    // 可能是「还没跑」的中间态（fallback 行 + 空标记），断言会假通过。
    await vi.waitFor(() => { expect(catalogSeen()).toBe(true) }, { timeout: 5000 })

    let body = ''
    const res = { writeHead: () => {}, end: (chunk: string) => { body = chunk } }
    await handler({ method: 'GET', headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' } }, res)
    return JSON.parse(body) as { catalog?: { empty?: true; source: string; error?: string }; models?: unknown[] }
  }

  it('真实插件：上游答空名单 → catalog.empty=true', async () => {
    const doc = await readPluginCatalog(async () => [] as readonly WorkBuddyModelInfo[])
    expect(doc.models).toEqual([])
    expect(doc.catalog).toEqual({ source: 'live', fetchedAt: expect.any(Number), empty: true })
  }, 30000)

  it('真实插件：上游拉取失败 → 不置 empty（那是故障，不是「没有模型」）', async () => {
    const doc = await readPluginCatalog(async () => { throw new Error('upstream down') })
    expect(doc.catalog?.empty).toBeUndefined()
    expect(doc.catalog?.error).toContain('upstream down')
  }, 30000)
})
