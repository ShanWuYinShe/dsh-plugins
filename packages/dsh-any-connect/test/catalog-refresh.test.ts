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
 * 返回**，只在若干远程事件上重拉。插件原先 registerAdapter 一次就再没动过注册，
 * 于是目录变了也不广播——用户看到的名单一直停在页面打开那一刻，直到手动刷新。
 *
 * 现在的接线：目录内容（含可见性）真的变了时 `ctx.emit('llm/models-updated',
 * provider)`（DSH 0.2.2 的公开事件，客户端 modelDirectories 订阅它并 refresh）。
 * 0.2.2 之前没有这个事件，只能借 `handle.replace([id])` 触发拓扑事件
 * llm/adapters-updated。重点在**只在变化时**通知：宿主每小时重拉一次目录，
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
  // 计数只认本变体的 `llm/models-updated`：那是插件目录发布的唯一出口
  // （见 src/catalog-refresh.ts 的 notifyCatalogChanged）。按 provider 过滤，
  // 与同进程的其它实例彻底解耦。
  const publishesByProvider = new Map<string, number>()
  const publishes = (): number => publishesByProvider.get('workbuddy') ?? 0
  ctx.on('llm/models-updated', (provider: string) => {
    publishesByProvider.set(provider, (publishesByProvider.get(provider) ?? 0) + 1)
  })
  // 交叉校验：事件确实进了宿主的公开事件面（客户端订阅的就是它）。
  const events = { count: 0 }
  ctx.on('llm/models-updated', () => { events.count += 1 })
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
    // 同样只数**本变体**的 `llm/models-updated`（理由见 installPlugin 的注释）。
    let replaced = 0
    await ctx.plugin(LlmRuntime)
    ctx.on('llm/models-updated', (provider: string) => {
      if (provider === 'workbuddy') replaced += 1
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
  })
})

describe('目录通知不会打断刷新链路', () => {
  it('通知走公开事件 llm/models-updated，失败不外溢、不误广播', async () => {
    // 目录通知现在是 `ctx.emit('llm/models-updated', provider)`（DSH 0.2.2 公开事件，
    // 客户端 modelDirectories 订阅它并 refresh()）。emit 是同步派发，没有
    // REGISTRATION_DISPOSED 这类可抛点；这里守的是两条不变量：
    //   1) 每次内容变化恰好发一次，且发的是本变体的 provider id；
    //   2) 即使有监听器抛错，也不得被 refreshCatalog 的泛捕获误判成「上游目录
    //      不可用」而触发重试风暴、打吓人的 warn。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-refresh-notify-'))
    const desktop = join(root, 'workbuddy-desktop.info')
    await writeFile(desktop, signedInDocument())
    let modelsCall = 0
    vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => { modelsCall += 1; return [catalogRow('alpha')] })

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    const seen: string[] = []
    ctx.on('llm/models-updated', (provider: string) => { seen.push(provider) })

    await ctx.plugin(WorkBuddy, { authFile: desktop, authFileAI: join(root, 'no-such-ai-file.info') })
    await vi.waitFor(async () => { expect(await servedIds()).toEqual(['alpha']) }, { timeout: 5000 })

    // 换一份**内容不同**的名单，确保这一轮一定走到 publishCatalog → notifyCatalogChanged。
    vi.spyOn(WorkBuddy.WorkBuddyUpstreamClient.prototype, 'fetchModels')
      .mockImplementation(async () => { modelsCall += 1; return [catalogRow('beta')] })
    const warnings: string[] = []
    const warnSpy = vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    const seenBefore = seen.length
    const callsBefore = modelsCall

    ctx.fiber.ctx.emit('loader/volatile-update', [])
    await vi.waitFor(async () => { expect(await servedIds()).toEqual(['beta']) }, { timeout: 5000 })
    // 通知真的发了，且带的是本变体的 provider id。
    await vi.waitFor(() => { expect(seen.length).toBeGreaterThan(seenBefore) }, { timeout: 5000 })
    expect(seen).toContain('workbuddy')

    // 没有误判成「上游目录不可用」：泛捕获若把通知异常当拉取失败，会打这条 warn
    // 并对同一份已拿到的新名单重试 3 次。
    expect(warnings.filter(line => line.includes('dynamic model catalog unavailable'))).toEqual([])
    // 没有重试风暴：本变体这一轮只多取一次上游。
    expect(modelsCall).toBeLessThanOrEqual(callsBefore + 1)
    warnSpy.mockRestore()
  })
})
