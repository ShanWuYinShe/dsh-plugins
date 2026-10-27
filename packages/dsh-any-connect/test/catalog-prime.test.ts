import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.js'
import { signedInDocument, catalogRow } from './catalog-harness.js'
import type { WorkBuddyModelInfo } from '../src/index.js'

/**
 * 「注册前预热目录」这条线的回归（2026-10-27 取证，全过程记录在项目 skill dsh-any-connect-zcode 第 5.4 节）：
 * 插件重载/宿主重启会腰斩在途请求，宿主的自动重试（TRANSPORT 可重试）若落在
 * 新实例「已注册但目录仍隐藏」的窗口里，pi-ai 的 modelOf 在空目录上抛
 * UNKNOWN_MODEL——不在默认可重试集合，整轮立即失败。修复是注册前本地采用
 * saved/fallback 目录（`primeCatalogForRegistration`，零网络）。
 *
 * 判据必须锚在**注册那一刻**：在 registerAdapter 被调用的瞬间采样 adapter 的
 * listModels——修复前该时刻目录恒为空（refreshCatalog 在注册之后才启动），
 * eventual 态两种代码都会到达，断言 eventual 态抓不住这个窗口。
 */
const CLEANUP: (() => Promise<void>)[] = []
let context: Context | undefined
let root: string | undefined
let envRestore: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (envRestore !== undefined) {
    process.env.DSH_HOME = envRestore
    envRestore = undefined
  }
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  root = undefined
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

/** 装宿主 + 插件；models 决定 fetchModels 对 CN 凭据的答案（挂起 = 永不落定）。
 * 返回「workbuddy 路由被注册那一刻」adapter 服务出去的模型 id 快照。 */
async function installPlugin(options: {
  desktopFile: string
  models: () => Promise<readonly WorkBuddyModelInfo[]>
}): Promise<{ idsAtRegistration: Promise<string[]>; ctx: Context }> {
  // 只让被测变体（workbuddy，CN）拿到挂起/指定名单，其余变体一律答空——
  // 既让断言只看 CN，也保证用例零真实网络（同 catalog-refresh.test.ts 的口径）。
  const models = options.models
  vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
    .mockImplementation(async function (this: unknown, credential: { domain?: string }) {
      return credential.domain === 'www.codebuddy.cn' ? await models() : []
    })
  // 独立 DSH_HOME：本文件的 live 改写用例会把 saved catalog 落盘；共享测试
  // home 会让下一个用例（以及下次运行）的预热读到别人的名单——uid-1 这份
  // 凭据被 catalog 系列测试共用，污染面不小。每个用例各用各的临时 home。
  const home = join(root!, 'dsh-home')
  envRestore = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  // 在原型上包一层 registerAdapter（ctx.llm 是 cordis Proxy，own property 拦不住
  // 插件内部的调用）：workbuddy 注册的那一刻同步采样 adapter.listModels——
  // 这正是重试请求在该时刻会解析到的名单。
  // 永不落定的占位：workbuddy 没注册成时由外层 waitFor 先红，不让 reject 逃成
  // unhandled rejection。
  let idsAtRegistration: Promise<string[]> = new Promise(() => {})
  const proto = Object.getPrototypeOf(ctx.llm) as { registerAdapter: (p: string[], a: unknown) => unknown }
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'registerAdapter')!
  const originalRegister = descriptor.value as (p: string[], a: unknown) => unknown
  Object.defineProperty(proto, 'registerAdapter', {
    ...descriptor,
    value: function (this: unknown, providers: string[], adapter: unknown) {
      if (providers[0] === 'workbuddy') {
        const listed = (adapter as { listModels: (p: string) => Promise<readonly { id: string }[]> })
          .listModels('workbuddy')
        idsAtRegistration = listed.then(rows => rows.map(row => row.id).sort())
      }
      return originalRegister.call(this, providers, adapter)
    },
  })
  try {
    await ctx.plugin(WorkBuddy, { authFile: options.desktopFile, authFileAI: join(tmpdir(), 'no-such-ai-file.info') })
    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    }, { timeout: 5000 })
  } finally {
    Object.defineProperty(proto, 'registerAdapter', descriptor)
  }
  return { idsAtRegistration, ctx }
}

/** 当前 provider 服务出去的模型 id，排序后便于断言。 */
async function servedIds(ctx: Context, provider = 'workbuddy'): Promise<string[]> {
  return (await ctx.llm.listModels(provider)).map(model => model.id).sort()
}

/** 永不落定的名单：live 拉取挂起，注册后的 refreshCatalog 停在等待上游。 */
function hangingModels(): Promise<readonly WorkBuddyModelInfo[]> {
  return new Promise(() => {})
}

describe('注册前预热：adapter 上路由那一刻目录已非空', () => {
  it('有 saved 目录的登录账号：注册那一刻就服务 saved 名单，不等 live 拉取', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-prime-saved-'))
    // 预写 saved 目录（installPlugin 会把 DSH_HOME 指到 root/dsh-home）。
    const home = join(root, 'dsh-home')
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, signedInDocument())
    const cacheDir = join(home, 'cache', 'dsh-any-connect')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, 'workbuddy-catalog.json'), `${JSON.stringify({
      version: 1,
      entries: {
        'uid-1:': {
          account: 'uid-1:',
          source: 'https://copilot.tencent.com',
          fetchedAtMs: Date.now(),
          models: [catalogRow('saved-row')],
        },
      },
    })}\n`)

    const { idsAtRegistration } = await installPlugin({ desktopFile: desktop, models: hangingModels })

    // 核心断言：注册那一刻（live 永不落定）就是 saved 名单。saved 优先于
    // fallback 也在这里证明（fallback 是内置 16 行，不含 saved-row）。
    expect(await idsAtRegistration).toEqual(['saved-row'])
    expect(await servedIds(context!)).toEqual(['saved-row'])
  })

  it('登录但无 saved：注册那一刻就服务 fallback 名单', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-prime-fallback-'))
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, signedInDocument())

    const { idsAtRegistration } = await installPlugin({ desktopFile: desktop, models: hangingModels })

    // 不等 live：注册那一刻即非空，内容是编译期兜底名单（含 hy4-preview）。
    const ids = await idsAtRegistration
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toContain('hy4-preview')
  })

  it('未登录：注册那一刻目录仍为空（隐藏语义不被预热破坏）', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-prime-signedout-'))
    const { idsAtRegistration, ctx } = await installPlugin({
      desktopFile: join(root, 'no-such-desktop.info'),
      models: async () => [],
    })

    // 空目录 = 分组隐藏的既有语义；预热只对「已登录」解锁目录。
    expect(await idsAtRegistration).toEqual([])
    expect(await servedIds(ctx)).toEqual([])
  })

  it('live 到场后照常改写：预热不改变 refreshCatalog 的身份/拉取链', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-prime-live-'))
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, signedInDocument())

    const { ctx } = await installPlugin({
      desktopFile: desktop,
      models: async () => [catalogRow('live-row')],
    })

    await vi.waitFor(async () => { expect(await servedIds(ctx)).toEqual(['live-row']) }, { timeout: 5000 })
  })
})
