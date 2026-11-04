import { describe, expect, it, vi } from 'vitest'
import { apply } from '../client/index.tsx'
import { NS } from '../client/locales.js'

/**
 * Client 入口（slot 注册 + 远程贡献挂载）与 HMR 处置回归。
 *
 * RULE-086：注册即 effect——插件 fiber 卸载/HMR 重载时必须先 dispose 再注册，
 * 否则 locale 字典与 slot 注册会泄漏/重复。这里用一个最小 fake slot renderer
 * 记录 `ctx.effect` / `ctx.slots.inject` / `ctx.slots.register` 的 disposer，
 * 模拟真实 client fiber 的「dispose → 观察移除」，再断言 apply 的注册被回收。
 */

interface Registration {
  slot: string
  options: any
  component: unknown
}

interface RuntimeOptions {
  workspaces?: boolean
  sessions?: boolean
  registerThrows?: boolean
}

function makeClientRuntime(options: RuntimeOptions = {}) {
  const effects: Array<() => void> = []
  const injectDisposers: Array<() => void> = []
  const registrations = new Map<string, Registration>()
  const dictionaries: string[] = []
  const removedDictionaries: string[] = []
  const mounted: any[] = []
  let remoteResult: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } } = { ok: true, value: { items: [] } }
  const remoteService = {
    list: async () => remoteResult,
    count: async () => remoteResult,
    detail: async () => remoteResult,
    delete: async () => remoteResult,
    unarchive: async () => remoteResult,
  }
  const ctx: any = {
    get(name: string) {
      if (name === 'remote.sessionArchive') return remoteService
      if (name === 'workspaces' && options.workspaces === true) {
        return { list: { subscribe: () => () => {}, getSnapshot: () => ({ archivedSessionIds: ['a', 'b'] }) } }
      }
      if (name === 'sessions' && options.sessions === true) return { refresh: async () => {} }
      return undefined
    },
    effect(fn: () => void | (() => void)) {
      const dispose = fn()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    locale: {
      bind: () => (key: string) => key,
      register(ns: string) {
        dictionaries.push(ns)
        return () => { removedDictionaries.push(ns) }
      },
    },
    remote: { $mount: async (contribution: unknown) => { mounted.push(contribution) } },
    slots: {
      inject(_slot: string, fn: () => void | (() => void)) {
        const dispose = fn()
        if (typeof dispose === 'function') injectDisposers.push(dispose)
        return dispose
      },
      register(registrationOptions: any, component: unknown) {
        if (options.registerThrows === true) throw new Error('slot registry unavailable')
        const key = String(registrationOptions.id)
        registrations.set(key, { slot: registrationOptions.name, options: registrationOptions, component })
        return () => { registrations.delete(key) }
      },
    },
  }
  /** 模拟 client fiber 卸载：反向执行 effect 与 slot 注入注册的 disposer。 */
  const dispose = () => {
    for (const disposer of [...effects].reverse()) disposer()
    for (const disposer of [...injectDisposers].reverse()) disposer()
    effects.length = 0
    injectDisposers.length = 0
  }
  return {
    ctx, registrations, mounted, dictionaries, removedDictionaries, dispose,
    setRemoteResult(result: typeof remoteResult) { remoteResult = result },
  }
}

describe('client apply：slot 注册 / 远程贡献挂载 / HMR dispose', () => {
  it('apply 挂载生成贡献、注册 locale 字典与 sidebar 入口；dispose 后全部回收', async () => {
    const runtime = makeClientRuntime()
    await apply(runtime.ctx)

    expect(runtime.mounted).toHaveLength(1)
    expect(runtime.mounted[0].package).toBe('@chaoset/session-archive')
    expect(runtime.dictionaries).toEqual([NS])
    expect(runtime.registrations.get('session-archive')?.slot).toBe('sidebar.footer.action')
    expect(runtime.registrations.get('session-archive')?.options.locale).toBe(NS)

    runtime.dispose()
    // HMR 处置：locale 字典与 slot 注册都被移除，不残留旧引用。
    expect(runtime.removedDictionaries).toEqual([NS])
    expect(runtime.registrations.size).toBe(0)

    // dispose 后重新 apply（等价 HMR reload）→ 重新注册且只注册一份。
    await apply(runtime.ctx)
    expect(runtime.mounted).toHaveLength(2)
    expect(runtime.dictionaries).toEqual([NS, NS])
    expect(runtime.registrations.size).toBe(1)
  })

  it('注入业务面：call 成功取 value、失败抛带 code 的结构化错误', async () => {
    const runtime = makeClientRuntime()
    await apply(runtime.ctx)
    const injected = runtime.registrations.get('session-archive')!.options.inject() as {
      call: (method: string, ...args: unknown[]) => Promise<unknown>
    }
    runtime.setRemoteResult({ ok: true, value: { items: [{ sessionId: 's1' }] } })
    await expect(injected.call('list')).resolves.toEqual({ items: [{ sessionId: 's1' }] })

    runtime.setRemoteResult({ ok: false, error: { code: 'remote-access/denied', message: 'denied' } })
    const error = await injected.call('delete', ['s1']).catch((reason: unknown) => reason) as Error & { code?: string }
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('remote-access/denied')
    expect(error.message).toContain('denied')
  })

  it('注入的宿主能力：workspaces store 计数、sessions 惰性刷新可用', async () => {
    const runtime = makeClientRuntime({ workspaces: true, sessions: true })
    await apply(runtime.ctx)
    const injected = runtime.registrations.get('session-archive')!.options.inject() as {
      refreshSessions: () => Promise<void> | undefined
      subscribeArchived?: (listener: () => void) => () => void
      archivedCountOf?: () => number
    }
    expect(typeof injected.subscribeArchived).toBe('function')
    expect(injected.archivedCountOf?.()).toBe(2)
    expect(typeof injected.refreshSessions()).toBe('object') // Promise
    // 服务缺失时静默降级（不因可选能力缺失阻断面板）。
    const fallback = makeClientRuntime()
    await apply(fallback.ctx)
    const bare = fallback.registrations.get('session-archive')!.options.inject() as {
      refreshSessions: () => Promise<void> | undefined
      subscribeArchived?: unknown
      archivedCountOf?: unknown
    }
    expect(bare.refreshSessions()).toBeUndefined()
    expect(bare.subscribeArchived).toBeUndefined()
    expect(bare.archivedCountOf).toBeUndefined()
  })

  it('slot 注册抛错时 apply 吞掉异常（不得炸宿主 loader）', async () => {
    const runtime = makeClientRuntime({ registerThrows: true })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(apply(runtime.ctx)).resolves.toBeUndefined()
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('client panel failed to load'), expect.any(Error))
    } finally {
      consoleError.mockRestore()
    }
  })
})
