// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/**
 * 注册形状回归（「pill 有时候不显示，刷新页面或重开插件才行」）。
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
 * 现取。这里用**真实 cordis Context** 装载真实入口模块，锁住这个形状。
 */

/** 目录服务桩：store 是 props 交付给 pill 的目录快照源，load 记调用次数。 */
function makeDirectories(): {
  store: { subscribe: () => () => void; getSnapshot: () => unknown }
  directoryFor: (sessionId: unknown) => unknown
  loadCount: () => number
} {
  const store = { subscribe: () => () => {}, getSnapshot: () => ({}) }
  let loads = 0
  return {
    store,
    directoryFor: () => ({
      store,
      load: () => {
        loads += 1
        return Promise.resolve()
      },
    }),
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
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
}

/** locale 服务桩：入口只用到 register / bind 两面。 */
function makeLocale(): unknown {
  return {
    register: () => () => {},
    bind: () => (key: string) => key,
  }
}

/** 让出若干微任务 + 一拍宏任务，等 cordis 的 fiber 结算（_reload 先 await 一拍）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/**
 * 只提供 slots/locale（不给 modelDirectories），装载真实入口模块。
 *
 * @param faults - 透传给 slots 桩的故障注入开关。
 */
async function mountEntry(faults: { throwOnRegister?: boolean } = {}): Promise<{
  ctx: Context
  registrations: Array<{ options: any; component: unknown }>
  directories: ReturnType<typeof makeDirectories>
  load: Promise<unknown>
}> {
  const mod = (await import('../client/index.tsx')) as unknown as { apply: (ctx: Context) => void }
  const slots = makeSlots(faults)
  const directories = makeDirectories()
  const ctx = new Context()
  ctx.provide('slots', slots.service as never)
  ctx.provide('locale', makeLocale() as never)
  const load = ctx.plugin(mod).await()
  await load
  await settle()
  return { ctx, registrations: slots.registrations, directories, load }
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
