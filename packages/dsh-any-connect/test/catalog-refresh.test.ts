import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as WorkBuddy from '../src/index.js'
import { signedInDocument, catalogRow } from './catalog-harness.js'
import type { WorkBuddyModelInfo } from '../src/index.js'

/**
 * 「模型选择框实时更新」这条线的回归。
 *
 * 背景（实测取证）：聊天页的选择框走宿主 session.modelCatalog()，而客户端
 * dsh-client-ui-model-selection 的 ModelCatalogDirectory.load() **命中缓存即直接
 * 返回**，只在四个远程事件上重拉，其中 llm/adapters-updated 是插件唯一能触发的
 * 那个。插件原先 registerAdapter 一次就再没动过注册，于是目录变了也不广播——
 * 用户看到的名单一直停在页面打开那一刻，直到手动刷新。
 *
 * 现在的接线：目录内容（含可见性）真的变了时调 handle.replace([id])，由 dsh-llm
 * 的路由变更点发布该事件。重点在**只在变化时**通知：宿主每小时重拉一次目录，
 * 无条件广播会让每个打开的客户端白重拉、白重渲染。
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



/**
 * 装一个真实宿主（LlmRuntime + 插件），并订阅 llm/adapters-updated——
 * 正是客户端订阅的那个事件。
 *
 * 监听器在插件安装**之前**挂上，所以首次注册（registerAdapter 自己也会发布一次）
 * 也在计数里："名单没变就不再广播"的断言必须成立在整段生命周期上，包含那一刻。
 */
async function installPlugin(options: {
  models?: () => Promise<readonly WorkBuddyModelInfo[]>
}): Promise<{ publishes: () => number; events: { count: number } }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-refresh-'))
  const desktop = join(root, 'workbuddy-desktop.info')
  await writeFile(desktop, signedInDocument())
  if (options.models !== undefined) {
    // **只让被测变体（workbuddy，CN）消费这份名单**：spy 挂在
    // WorkBuddyUpstreamClient.prototype 上，四个变体的 fetchModels 都会走它。
    // 若不加区分，四个变体会抢同一个序列——谁先落定谁吃掉一项，而被测变体
    // 拿到哪一项取决于并发时序，用例就会随机红（实测全量跑约 2/3 概率失败）。
    // 其余变体一律答空名单：它们与断言无关，也就不会制造无关广播。
    const models = options.models
    vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async function (this: unknown, credential: { domain?: string }) {
        return credential.domain === 'www.codebuddy.cn' ? await models() : []
      })
  }
  const ctx = new Context()
  context = ctx
  await ctx.plugin(LlmRuntime)
  //
  // 计数必须**只认本插件对这个 provider 的发布**，不能数宿主全局的
  // llm/adapters-updated。原因（lead 实测定位）：ctx.on 是无过滤的全局订阅，
  // 同一 vitest worker 里若有另一个存活实例（或某个文件的 dispose 尚未落定、
  // fire-and-forget 的发布刚好落在本用例窗口内），那一次事件也会被计入，
  // 于是全量跑时恒比基线多 1、单跑却全绿——典型的跨文件状态污染。
  //
  // 包一层 registerAdapter，只统计本插件拿到的句柄上的 replace：replace 正是
  // 「内容变化 → 通知宿主」这条线的唯一出口（见 index.ts notifyCatalogChanged）。
  // 这样用例断言的是**本插件的行为**，与同进程的其它实例彻底解耦。
  const publishesByProvider = new Map<string, number>()
  const publishes = (): number => publishesByProvider.get('workbuddy') ?? 0
  const proto = Object.getPrototypeOf(ctx.llm) as { registerAdapter: (p: string[], a: unknown) => unknown }
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'registerAdapter')!
  const originalRegister = descriptor.value as (p: string[], a: unknown) => unknown
  Object.defineProperty(proto, 'registerAdapter', {
    ...descriptor,
    value: function (this: unknown, providers: string[], adapter: unknown) {
      const handle = originalRegister.call(this, providers, adapter) as (() => void) & { replace: (p: string[]) => void }
      const originalReplace = handle.replace.bind(handle)
      handle.replace = (next: string[]) => {
        publishesByProvider.set(providers[0]!, (publishesByProvider.get(providers[0]!) ?? 0) + 1)
        return originalReplace(next)
      }
      return handle
    },
  })
  // 交叉校验：本用例的插件确实在发那个事件（而不是我们数错了东西）。
  const events = { count: 0 }
  ctx.on('llm/adapters-updated', () => { events.count += 1 })
  await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
// 本文件的等待都覆盖真实 I/O（插件注册 / 目录刷新），显式给 5s 预算：
// vi.waitFor 的默认超时是 1s，而 testTimeout 是 30s——并行负载下真实 I/O 可能超过 1s，
// 默认值会造成偶发失败（见 usage.test.ts 那次注册竞态）。
  await vi.waitFor(() => {
    expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
  }, { timeout: 5000 })
  return { publishes, events }
}

/** 当前 provider 服务出去的模型 id，排序后便于断言。 */
async function servedIds(provider = 'workbuddy'): Promise<string[]> {
  return (await context!.llm.listModels(provider)).map(model => model.id).sort()
}

describe('目录变化 → 通知宿主实时刷新模型选择框', () => {
  it('名单变化才广播：内容相同的刷新一次都不多播', async () => {
    // 同一份名单先服务两次，再换成另一份，最后清空。核心断言是第二次（内容与
    // 第一次完全相同）**一次都不广播**——宿主每小时的定时刷新绝大多数都属于这种，
    // 无条件广播会让每个打开的客户端每小时白重拉一次目录。
    //
    // 计数基线说明：宿主对每个变体有 2 次固有广播（registerAdapter 与
    // registerConfigurableProviders 各一次，实测），插件自己再加 1 次目录发布。
    // 这里只关心"增量"，所以先记下基线再比差值，不写死绝对数。
    const roster: WorkBuddyModelInfo[][] = [[catalogRow('alpha')], [catalogRow('alpha')], [catalogRow('beta')], []]
    const { publishes, events } = await installPlugin({ models: async () => roster.shift() ?? [] })

    await vi.waitFor(async () => { expect(await servedIds()).toEqual(['alpha']) }, { timeout: 5000 })
    // 等第一轮目录发布落定（下面按"本变体的发布次数"记基线，见 publishes）。
    await new Promise(resolve => setTimeout(resolve, 200))
    const settled = publishes()

    // 上游这一拍答的仍是内容相同的 [alpha]：本变体不得再广播——核心断言。
    context!.fiber.ctx.emit('loader/volatile-update', [])
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(await servedIds()).toEqual(['alpha'])
    expect(publishes()).toBe(settled)

    // 上游换名单：内容变了 → 广播。
    context!.fiber.ctx.emit('loader/volatile-update', [])
    await vi.waitFor(async () => { expect(await servedIds()).toEqual(['beta']) }, { timeout: 5000 })
    await vi.waitFor(() => { expect(publishes()).toBeGreaterThan(settled) }, { timeout: 5000 })
    // 交叉校验：这次本变体的 replace **确实转化成了宿主的 llm/adapters-updated**
    // ——正是客户端订阅的那个事件。没有这条，本用例只证明了"我们调了自己的
    // 计数函数"，而这正是本任务要交付的因果链。
    expect(events.count).toBeGreaterThan(0)
    const afterBeta = publishes()

    // 名单被清空：空目录是合法且对用户可见的变化（DSH 隐藏该分组），必须通知。
    context!.fiber.ctx.emit('loader/volatile-update', [])
    await vi.waitFor(async () => { expect(await servedIds()).toEqual([]) }, { timeout: 5000 })
    await vi.waitFor(() => { expect(publishes()).toBeGreaterThan(afterBeta) }, { timeout: 5000 })
  })

  it('费率变化也算内容变化：名称后缀改了就要广播', async () => {
    // 用户看得见的"费率/徽标"直接写在模型展示名后缀上（x0.79 / 免费），只比 id
    // 会漏掉"同一批模型、促销上下线"这种最常见的漂移。
    const priced = (credits: string): WorkBuddyModelInfo => ({
      ...catalogRow('glm-5.3', 'GLM-5.3'),
      billing: { credits, free: false },
    })
    let credits = 'x0.79'
    const { publishes } = await installPlugin({ models: async () => [priced(credits)] })

    await vi.waitFor(async () => {
      const listed = await context!.llm.listModels('workbuddy')
      expect(listed.map(model => model.name)).toEqual(['GLM-5.3 · x0.79'])
    }, { timeout: 5000 })
    const afterFirst = publishes()

    // 上游下调费率：id 没变，但用户看到的名字变了。
    credits = 'x0.31'
    context!.fiber.ctx.emit('loader/volatile-update', [])
    await vi.waitFor(async () => {
      const listed = await context!.llm.listModels('workbuddy')
      expect(listed.map(model => model.name)).toEqual(['GLM-5.3 · x0.31'])
    }, { timeout: 5000 })
    await vi.waitFor(() => { expect(publishes()).toBeGreaterThan(afterFirst) }, { timeout: 5000 })
  })

  it('登录后分组由隐藏变可见，同样广播', async () => {
    // 用户在桌面端登录，是"选择框里没有我的模型"最常见的原因。可见性翻转也是
    // 目录内容变化，必须通知，否则用户得刷新页面才看得见新分组。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-refresh-signin-'))
    const desktop = join(root, 'workbuddy-desktop.info')
    vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => [catalogRow('alpha')])
    const ctx = new Context()
    context = ctx
    // 同样只数**本变体**的 replace（理由见 installPlugin 的注释）。
    let replaced = 0
    await ctx.plugin(LlmRuntime)
    const signInProto = Object.getPrototypeOf(ctx.llm) as { registerAdapter: (p: string[], a: unknown) => unknown }
    const signInDescriptor = Object.getOwnPropertyDescriptor(signInProto, 'registerAdapter')!
    const signInRegister = signInDescriptor.value as (p: string[], a: unknown) => unknown
    Object.defineProperty(signInProto, 'registerAdapter', {
      ...signInDescriptor,
      value: function (this: unknown, providers: string[], adapter: unknown) {
        const handle = signInRegister.call(this, providers, adapter) as (() => void) & { replace: (p: string[]) => void }
        const originalReplace = handle.replace.bind(handle)
        handle.replace = (next: string[]) => {
          if (providers[0] === 'workbuddy') replaced += 1
          return originalReplace(next)
        }
        return handle
      },
    })
    await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })

    await vi.waitFor(() => {
      expect(ctx.llm.listProviders().map(provider => provider.id)).toContain('workbuddy')
    }, { timeout: 5000 })
    // 未登录：分组隐藏（空目录）。
    await vi.waitFor(async () => { expect(await ctx.llm.listModels('workbuddy')).toEqual([]) }, { timeout: 5000 })
    const hidden = replaced

    await writeFile(desktop, signedInDocument())
    ctx.fiber.ctx.emit('loader/volatile-update', [])
    await vi.waitFor(async () => { expect(await servedIds()).toEqual(['alpha']) }, { timeout: 5000 })
    await vi.waitFor(() => { expect(replaced).toBeGreaterThan(hidden) }, { timeout: 5000 })
    Object.defineProperty(signInProto, 'registerAdapter', signInDescriptor)
  })
})

describe('注册已释放（REGISTRATION_DISPOSED）不影响刷新链路', () => {
  it('replace 抛 REGISTRATION_DISPOSED 时被吞掉，不冒泡、不误广播', async () => {
    // 插件卸载、或注册与通知之间的竞态，会让 replace 抛 LlmError
    // REGISTRATION_DISPOSED。这是正常路径：通知发不出去就算了，绝不能让异常
    // 冒泡打断 refreshCatalog。
    //
    // 这里**主动制造**该异常：包装注册句柄，让 replace 在被释放后按真实语义抛
    // REGISTRATION_DISPOSED（而不是依赖 dispose 时序去撞它）。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-refresh-disposed-'))
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, signedInDocument())
    let modelsCall = 0
    vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => { modelsCall += 1; return [catalogRow('alpha')] })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    // 挂到 LlmRuntime 的**原型**上：ctx.llm 是 cordis Proxy，插件内部调用的
    // 是原型方法；直接给 ctx.llm 赋一个同名 own property 是拦不住的（会静默
    // 不生效，测试变成永远为真的空断言）。
    const proto = Object.getPrototypeOf(ctx.llm) as { registerAdapter: (p: string[], a: unknown) => unknown }
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'registerAdapter')!
    const originalRegister = descriptor.value as (p: string[], a: unknown) => unknown
    let disposeThrows = false
    let replaceAttempts = 0
    Object.defineProperty(proto, 'registerAdapter', {
      ...descriptor,
      value: function (this: unknown, providers: string[], adapter: unknown) {
        const handle = originalRegister.call(this, providers, adapter) as (() => void) & { replace: (p: string[]) => void }
        const originalReplace = handle.replace.bind(handle)
        handle.replace = (next: string[]) => {
          replaceAttempts += 1
          if (disposeThrows) {
            const error = new Error('adapter registration is disposed') as Error & { code: string }
            error.code = 'REGISTRATION_DISPOSED'
            throw error
          }
          return originalReplace(next)
        }
        return handle
      },
    })

    try {
      await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
      await vi.waitFor(async () => { expect(await servedIds()).toEqual(['alpha']) }, { timeout: 5000 })
      disposeThrows = true

      // 换一份**内容不同**的名单，确保这一轮一定走到 publishCatalog → replace。
      vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
        .mockImplementation(async () => { modelsCall += 1; return [catalogRow('beta')] })
      const warnings: string[] = []
      const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.map(String).join(' '))
      })
      const attemptsBefore = replaceAttempts
      const callsBefore = modelsCall

      ctx.fiber.ctx.emit('loader/volatile-update', [])
      // 这一轮必然取一次上游（拿到 [beta]）；若通知异常逃逸，refreshCatalog 的
      // 泛捕获会把这次拉取判成失败 → 触发 3 次重试，modelsCall 就会涨到 4。
      await vi.waitFor(async () => { expect(await servedIds()).toEqual(['beta']) }, { timeout: 5000 })
      // 这条路径**真的**走到了 replace —— 没有这条，把 notifyCatalogChanged
      // 整个删掉用例也照样"通过"。
      await vi.waitFor(() => { expect(replaceAttempts).toBeGreaterThan(attemptsBefore) }, { timeout: 5000 })

      // 核心断言：replace 抛出的 REGISTRATION_DISPOSED 被就地吞掉。
      //
      // 不吞会发生什么（实测）：refreshCatalog 的 async IIFE 里 publishCatalog 之后
      // 还有落盘与探针入队，"目录加载失败"这个泛捕获会把这条通知异常误判成
      // **上游目录不可用** —— 于是打一条吓人的 warn（"dynamic model catalog
      // unavailable ... serving the last-known list"），并对同一份已经拿到的
      // 新名单再重试 3 次无谓的上游请求。用户看到的是永不消停的告警与多余流量。
      expect(warnings.filter(line => line.includes('dynamic model catalog unavailable'))).toEqual([])
      // 至少又多走了一次 replace（本次 workbuddy 的发布）；不写死成 +1，因为
      // 其它三个变体的启动拉取可能同一时刻落定，各自也会发布一次。
      expect(replaceAttempts).toBeGreaterThan(attemptsBefore)
      // 没有重试风暴：本变体这一轮只多取一次上游。若通知异常逃逸，泛捕获会把它
      // 判成拉取失败并追加 3 次重试，这里立刻变成 4。
      expect(modelsCall).toBeLessThanOrEqual(callsBefore + 1)
      warnSpy.mockRestore()
    } finally {
      disposeThrows = false
      Object.defineProperty(proto, 'registerAdapter', descriptor)
    }
  })
})
