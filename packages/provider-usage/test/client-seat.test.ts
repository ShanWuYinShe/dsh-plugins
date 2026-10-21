// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/**
 * 注册时序回归（缺陷 1「有时候不显示，刷新页面或重新开关插件才行」）。
 *
 * 宿主 renderer 把一个 entry 的 `inject` 结果按 (entry × 会话绑定) **永久缓存**
 * （dsh-client-ui-renderer 的 cachedSessionInject / sessionInjectCache，无失效
 * 路径）。旧实现在 apply 里同步注册 entry、并在 props 里同步
 * `ctx.get('modelDirectories')`——目录服务的提供方 fiber 尚未 active 时 cordis
 * 的严格 get 静默返回 undefined，那份缺 directory 的 props 就此被永久缓存，
 * 该会话整页再也长不出 pill，直到 entry 被重新注册（用户手工刷新/重开插件）。
 *
 * 这里用**真实 cordis Context** 装载真实入口模块（不是抄一遍 apply 的镜像
 * 测试），锁定「等目录服务就绪后才注册 entry」这条顺序。
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
      // 真机契约（dsh-client-ui-renderer 的 SlotRegistry.inject）：声明已存在时
      // 同步执行回调，返回幂等 disposer；贡献的撤下由该实现绑在调用方 fiber 上
      // （桩不模拟 fiber 生命周期，故用例只断言"重新注册"，不断言"撤下"）。
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
 * @returns 装载后的上下文、注册记录、目录服务桩，以及插件装载 promise（供
 * 用例断言"不冒泡"）。
 */
async function mountEntryWithoutDirectory(faults: { throwOnRegister?: boolean } = {}): Promise<{
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
  // 真实入口模块（name/inject/apply 齐备，inject 在运行时读）按宿主 loader 的
  // 方式装载：声明的 slots/locale 已就绪，故 apply 立即执行。
  const load = ctx.plugin(mod).await()
  await load
  await settle()
  return { ctx, registrations: slots.registrations, directories, load }
}

describe('provider-usage dock entry 注册时序', () => {
  it('目录服务缺席时不注册 entry；就绪后注册并解析出目录与 lazy load', async () => {
    const { ctx, registrations, directories } = await mountEntryWithoutDirectory()

    // 断言 1：目录服务缺席 → 一个 entry 都不许注册。旧实现此刻已经注册了一个
    // props 只有 {t} 的 entry，那份 props 会被宿主永久缓存 → 整页没有 pill。
    expect(registrations, '目录服务缺席时不得注册 dock entry').toHaveLength(0)

    // 断言 2：服务就绪 → 子 fiber 结算 → entry 注册完成。
    ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
    await settle()
    expect(registrations, '目录服务就绪后必须注册 dock entry').toHaveLength(1)
    const [dock] = registrations
    expect(dock!.options.name).toBe('conversation.composer.dock')
    expect(dock!.options.id).toBe('provider-usage')
    expect(dock!.options.order).toBe(10)
    expect(typeof dock!.component).toBe('function')

    // props 的两条取数路径：无 session 只回译写函数；有 session 解析出目录。
    const bare = dock!.options.inject()
    expect(typeof bare.t).toBe('function')
    expect(bare.directory).toBeUndefined()
    expect(bare.load).toBeUndefined()
    const seated = dock!.options.inject('session-1')
    expect(seated.directory).toBe(directories.store)
    expect(typeof seated.load).toBe('function')
    seated.load()
    expect(directories.loadCount()).toBe(1)
  })

  it('目录服务重启后 entry 重新注册（等价于用户手工重开插件）', async () => {
    const { ctx, registrations, directories } = await mountEntryWithoutDirectory()
    const dispose = ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
    await settle()
    expect(registrations).toHaveLength(1)
    const firstEntry = registrations[0]!.options

    // 服务消失：注册子 fiber 连带被销毁（真机上 entry 由 SlotRegistry 绑在
    // 调用方 fiber 上的 effect 撤下，桩不模拟这一段，故不断言撤下）。
    await dispose()
    await settle()

    // 服务重启 → cordis 重跑注册子 fiber → 新 entry（拿到全新 props 解析），
    // 这正是用户手工「重开插件」所做的事，现在由服务生命周期自动完成。
    ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
    await settle()
    expect(registrations, '服务回来后会再注册一份 entry').toHaveLength(2)
    expect(registrations[1]!.options).not.toBe(firstEntry)
    expect(registrations[1]!.options.inject('session-1').directory).toBe(directories.store)
  })

  it('子 fiber body 内注册抛错：同句 console.error 兜底且不冒泡', async () => {
    // 注册体跑在 cordis 的微任务边界里，apply 的 try/catch 包不到它；这条锁住
    // body 内的第二层兜底——否则异常只进 cordis logger，本包文案静默丢失。
    const errors: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    try {
      const { ctx, registrations, directories, load } = await mountEntryWithoutDirectory({ throwOnRegister: true })
      // 装载本身不得 reject：apply 同步段无错，抛错发生在子 fiber body 里。
      await expect(load, '注册抛错不得冒泡到宿主 loader').resolves.toBeDefined()

      ctx.provide('modelDirectories', { directoryFor: directories.directoryFor } as never)
      await settle()

      expect(registrations, '注册抛错时不得留下 entry').toHaveLength(0)
      expect(
        errors.some(line => line.includes('[provider-usage] client pill failed to load (host registry unaffected):')),
        'body 内的抛错必须走本包同一句兜底文案',
      ).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('会话目录未就绪抛错时不吞成空 props（防止 cachedSessionInject 永久固化缺 directory 的坏缓存）', async () => {
    const { ctx, registrations } = await mountEntryWithoutDirectory()
    ctx.provide('modelDirectories', {
      directoryFor: (sessionId: unknown) => {
        if (sessionId === 'session-unready') throw new Error('session resolved no scope')
        return { store: {}, load: () => Promise.resolve() }
      },
    } as never)
    await settle()
    expect(registrations).toHaveLength(1)
    const [dock] = registrations
    // 无 sessionId 正常返回 { t }
    expect(dock!.options.inject().directory).toBeUndefined()
    // 有 sessionId 但目录服务抛错：绝不能返回 { t }，必须抛出以阻止 sessionInjectCache 固化
    expect(() => dock!.options.inject('session-unready')).toThrow('session resolved no scope')
  })
})
