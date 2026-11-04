// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/**
 * 注册形状与数据通道路径回归（「pill 有时候不显示，刷新页面或重开插件才行」）。
 *
 * 对照宿主自带的两个 pill（dsh-client-ui-chat 的 activity / usage）：它们的
 * `inject` 是**无参常量函数** `() => ({ hooks: { performanceUsage } })`，注册期
 * 不解析任何会话或服务状态；会话数据全部走 standard kit（`sessionId` /
 * `useProjection`），而 standard kit 由 renderer 无条件提供，永远可用。
 *
 * 这正是它们从不失效的结构性原因。本包此前在注册期解析目录服务，撞上两条
 * 宿主机制：
 *
 * 1. `cachedSessionInject` 按 (entry × 会话绑定) 永久缓存 inject 结果；
 * 2. render 期抛错 → `SlotErrorBoundary` → `reportEntryError({abdicate:true})`
 *    → `SlotRegistry.abdicated`（只增不减的 WeakSet）→ entry 永久退出投影。
 *
 * 现在改成同一形状：`inject` 无参且恒定，目录在组件渲染期经 `resolveSeat`
 * 现取。同时锁住唯一的额度数据通道：apply 必须把协议 'provider-usage' 的
 * ResourceProvider 注册到 ctx.resources（不再有组件内轮询兜底）。
 * 这里用**真实 cordis Context** 装载真实入口模块，锁住这两个形状。
 */

/**
 * 目录服务桩：store 是 props 交付给 pill 的目录快照源，load 记调用次数。
 *
 * `directoryFor` 按会话返回**同一个目录实例**（宿主 ModelDirectory 的真实语义）：
 * 本包按目录对象 identity 缓存 load 闭包，每次新建对象会让缓存永不命中。
 */
function makeDirectories(): {
  store: { subscribe: () => () => void; getSnapshot: () => unknown }
  directoryFor: (sessionId: unknown) => unknown
  loadCount: () => number
} {
  const store = { subscribe: () => () => {}, getSnapshot: () => ({}) }
  let loads = 0
  const directories = new Map<unknown, { store: typeof store; load: () => Promise<void> }>()
  return {
    store,
    directoryFor: (sessionId: unknown) => {
      let directory = directories.get(sessionId)
      if (directory === undefined) {
        directory = {
          store,
          load: () => {
            loads += 1
            return Promise.resolve()
          },
        }
        directories.set(sessionId, directory)
      }
      return directory
    },
    loadCount: () => loads,
  }
}

/**
 * slots 服务桩：复刻 SlotRegistry 的注册面（调用即记录，返回幂等 disposer）。
 *
 * @param faults - `throwOnRegister` 模拟 DSH slot 契约变更：register 直接抛错。
 */
function makeSlots(faults: { throwOnRegister?: boolean } = {}): {
  service: unknown
  registrations: Array<{ options: any; component: unknown }>
} {
  const registrations: Array<{ options: any; component: unknown }> = []
  return {
    registrations,
    service: {
      inject: (_slot: string, callback: () => unknown) => {
        callback()
        return () => {}
      },
      register: (options: unknown, component: unknown) => {
        if (faults.throwOnRegister === true) throw new Error('keyed slot requires options.key')
        const registration = { options, component }
        registrations.push(registration)
        // 与真实 SlotRegistry 一致：disposer 移除 entry（宿主 fiber 卸载/HMR 时调用）。
        return () => {
          const index = registrations.indexOf(registration)
          if (index >= 0) registrations.splice(index, 1)
        }
      },
    },
  }
}

/** locale 服务桩：入口用到 register / bind，以及注入面 hooks.locale 的快照源。 */
function makeLocale(): {
  service: unknown
  snapshot: { active: string; locales: unknown[]; revision: number }
  registerDisposals: () => number
} {
  const snapshot = { active: 'zh', locales: [], revision: 0 }
  let disposals = 0
  return {
    snapshot,
    registerDisposals: () => disposals,
    service: {
      register: () => () => { disposals += 1 },
      bind: () => (key: string) => key,
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
  }
}

/** resources 服务桩：记录协议 provider 注册，返回真正移除协议的幂等 disposer。 */
function makeResources(): { service: unknown; protocols: string[] } {
  const protocols: string[] = []
  return {
    protocols,
    service: {
      register: (provider: { protocol: string }) => {
        protocols.push(provider.protocol)
        return () => {
          const index = protocols.indexOf(provider.protocol)
          if (index >= 0) protocols.splice(index, 1)
        }
      },
    },
  }
}

/**
 * 让出若干微任务 + 一拍宏任务，等 cordis 的 fiber 结算。
 *
 * 具体等的是两件事：① 服务 provide 与插件 apply 里同步注册的 effect 在
 * `ctx.plugin(...)` 返回后经微任务结算；② cordis `_reload` 的 fiber 状态机
 * 会先 `await` 一拍宏任务（`setTimeout(0)`）再让 `load` promise 落地。这里
 * 不是「睡固定时长等某状态先发生」的负向断言——每次等待后都直接断言真实
 * 注册结果，注册没完成就是红。
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/**
 * 只提供 slots/locale/resources（不给 modelDirectories），装载真实入口模块。
 *
 * @param faults - 透传给 slots 桩的故障注入开关。
 */
async function mountEntry(faults: { throwOnRegister?: boolean } = {}): Promise<{
  ctx: Context
  registrations: Array<{ options: any; component: unknown }>
  directories: ReturnType<typeof makeDirectories>
  locale: ReturnType<typeof makeLocale>
  resources: ReturnType<typeof makeResources>
  load: Promise<unknown>
}> {
  const mod = (await import('../client/index.tsx')) as unknown as { apply: (ctx: Context) => void }
  const slots = makeSlots(faults)
  const directories = makeDirectories()
  const locale = makeLocale()
  const resources = makeResources()
  const ctx = new Context()
  ctx.provide('slots', slots.service as never)
  ctx.provide('locale', locale.service as never)
  ctx.provide('resources', resources.service as never)
  const load = ctx.plugin(mod).await()
  await load
  await settle()
  return { ctx, registrations: slots.registrations, directories, locale, resources, load }
}

describe('provider-usage dock entry 注册形状（对齐宿主自带 pill）', () => {
  it('inject 是无参常量：不解析会话、不碰服务，永不抛错', async () => {
    const { registrations } = await mountEntry()
    expect(registrations, '注册不依赖目录服务是否就绪').toHaveLength(1)
    const [dock] = registrations
    expect(dock!.options.name).toBe('conversation.composer.dock')
    expect(dock!.options.id).toBe('provider-usage')
    expect(dock!.options.order).toBe(10)
    expect(typeof dock!.component).toBe('function')

    // 宿主 statPillInject 的形状：零参数调用即可拿到 props。
    const props = dock!.options.inject()
    expect(typeof props.t).toBe('function')
    expect(typeof props.resolveSeat).toBe('function')
    // 关键：props 里**不含**会话状态——它是常量，所以缓存它永远不会变坏。
    expect('directory' in props).toBe(false)
    expect('sessionId' in props).toBe(false)
  })

  it('多次调用 inject 返回等价 props（可安全被宿主永久缓存）', async () => {
    const { registrations } = await mountEntry()
    const [dock] = registrations
    const first = dock!.options.inject()
    const second = dock!.options.inject()
    // t 是同一份绑定；resolveSeat 每次是新闭包但**行为等价**——两者都不含
    // 任何会「过期」的会话快照，所以宿主缓存任意一份都安全。
    expect(first.t).toBe(second.t)
    expect(typeof first.resolveSeat).toBe('function')
    expect(typeof second.resolveSeat).toBe('function')
    expect(first.resolveSeat?.('same-session')).toBeUndefined()
    expect(second.resolveSeat?.('same-session')).toBeUndefined()
    // keyedHooks 每次 inject 是新 resolver 但行为等价（同样的目录解析）。
    expect(first.keyedHooks.modelDirectory('same-session')).toBeUndefined()
    expect(second.keyedHooks.modelDirectory('same-session')).toBeUndefined()
  })

  it('目录服务缺席时 resolveSeat 返回 undefined 而非抛错', async () => {
    const { registrations } = await mountEntry()
    const [dock] = registrations
    const { resolveSeat } = dock!.options.inject()
    // 未 provide modelDirectories：strict get 返回 undefined，解析收敛成 undefined。
    expect(() => resolveSeat('session-1')).not.toThrow()
    expect(resolveSeat('session-1')).toBeUndefined()
  })

  it('目录服务就绪后 resolveSeat 解析出目录与 lazy load', async () => {
    const { ctx, registrations, directories } = await mountEntry()
    const [dock] = registrations
    const { resolveSeat } = dock!.options.inject()

    ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
    await settle()

    const seat = resolveSeat('session-1')
    expect(seat?.directory).toBe(directories.store)
    expect(typeof seat?.load).toBe('function')
    seat!.load()
    expect(directories.loadCount()).toBe(1)
  })

  it('注入面携带 keyedHooks.modelDirectory（官方 reactive 事实通道）', async () => {
    const { ctx, registrations, directories } = await mountEntry()
    const [dock] = registrations
    const props = dock!.options.inject()
    // 组件不再自己 useSyncExternalStore 订阅裸 store：目录快照经 keyedHooks
    // 交给 renderer 绑定成 useModelDirectory（官方 ui-plan `plans: (turn) => …`
    // 同形）。目录服务未就绪时 resolver 返回 undefined（这一帧不渲染）。
    expect(typeof props.keyedHooks.modelDirectory).toBe('function')
    expect(props.keyedHooks.modelDirectory('session-1')).toBeUndefined()

    ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
    await settle()
    expect(props.keyedHooks.modelDirectory('session-1')).toBe(directories.store)
  })

  it('注入面携带 locale 快照源（renderer 据此绑定组件侧 useLocale）', async () => {
    const { registrations, locale } = await mountEntry()
    const [dock] = registrations
    const props = dock!.options.inject()
    // 数字/时间格式化要跟随 DSH 当前语言，而不是浏览器语言：注入面的 hooks
    // 隔间提供 LocaleFace 同形的快照源，renderer 把它绑定成组件 props 上的
    // useLocale selector hook（见 pill-types.ts）。
    expect(props.hooks.locale.getSnapshot()).toBe(locale.snapshot)
    const unsubscribe = props.hooks.locale.subscribe(() => {})
    expect(typeof unsubscribe).toBe('function')
  })

  it('load 闭包缓存归属本次 inject 面，不再是模块级状态（F-PU-11）', async () => {
    const { ctx, registrations, directories } = await mountEntry()
    const [dock] = registrations
    ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
    await settle()

    const firstFace = dock!.options.inject()
    const a = firstFace.resolveSeat('session-1')
    const b = firstFace.resolveSeat('session-1')
    // 同一 inject 面内同一目录复用同一个 load 闭包：组件的加载 effect 依赖
    // 它的 identity，每帧新建会反复重拉目录。
    expect(a?.load).toBe(b?.load)

    const secondFace = dock!.options.inject()
    const c = secondFace.resolveSeat('session-1')
    // 缓存随 inject 面（宿主按 entry × 会话绑定缓存它）而不是模块：两个面
    // 各自持有自己的 WeakMap，模块级 loadCache 已不存在。
    expect(c?.directory).toBe(a?.directory)
    expect(c?.load).not.toBe(a?.load)
  })

  it('无 sessionId / 空 sessionId 时返回 undefined（没有会话就没有可报的账号）', async () => {
    const { ctx, registrations, directories } = await mountEntry()
    const [dock] = registrations
    const { resolveSeat } = dock!.options.inject()
    ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
    await settle()

    expect(resolveSeat(undefined)).toBeUndefined()
    expect(resolveSeat(null)).toBeUndefined()
    expect(resolveSeat('')).toBeUndefined()
  })

  it('directoryFor 抛错（会话 scope 未就绪/已销毁）也不穿透', async () => {
    const { ctx, registrations } = await mountEntry()
    const [dock] = registrations
    const { resolveSeat } = dock!.options.inject()
    ctx.provide('modelDirectories', {
      directoryFor: () => { throw new Error('session resolved no scope') },
    } as never)
    await settle()

    // 这条锁住「render 期绝不抛错」：抛错会被宿主 SlotErrorBoundary 捕获，
    // 进而把 entry 永久 abdicate（SlotRegistry.abdicated 只增不减）。
    for (const sessionId of ['s1', 42, { nested: true }, 'session-unready']) {
      expect(
        () => resolveSeat(sessionId),
        `sessionId=${JSON.stringify(sessionId)} 时不得抛错`,
      ).not.toThrow()
      expect(resolveSeat(sessionId)).toBeUndefined()
    }
  })

  it('额度数据单一通道：apply 为协议 provider-usage 注册 resources provider', async () => {
    const { resources } = await mountEntry()
    // 轮询兜底已删除；额度只能来自 resource 流，协议注册少一次就整块失效。
    expect(resources.protocols).toEqual(['provider-usage'])
  })

  it('fiber dispose 回收 effect 注册：resource 协议与 locale 字典都被反注册（HMR 安全）', async () => {
    // 「注册即 effect」：插件 HMR 重载/卸载时，宿主 fiber 会执行 apply 期间
    // 收集的 disposer。这里用真实 cordis Context 装载真实入口，dispose 后断言
    // 反注册真的发生——残留的协议注册会让重载后的插件「协议已被占用」。
    const { resources, locale, load } = await mountEntry()
    expect(resources.protocols).toEqual(['provider-usage'])
    expect(locale.registerDisposals()).toBe(0)

    const fiber = await load as unknown as { dispose: () => Promise<void> }
    await fiber.dispose()

    expect(resources.protocols).toEqual([])
    expect(locale.registerDisposals()).toBe(1)
  })

  it('注册体抛错：同句 console.error 兜底且不冒泡', async () => {
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    try {
      const { registrations, load } = await mountEntry({ throwOnRegister: true })
      await expect(load, '注册抛错不得冒泡到宿主 loader').resolves.toBeDefined()
      expect(registrations, '注册抛错时不得留下 entry').toHaveLength(0)
      expect(
        errors.some(line => line.includes('[provider-usage] client pill failed to load (host registry unaffected):')),
        'body 内的抛错必须走本包同一句兜底文案',
      ).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})
