/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NS, zh } from "../client/locales.js"

/**
 * client/index.tsx 的行为测试（此前 0% 覆盖）：locale 字典注册（disposer 交回
 * effect）、typert 远程贡献 $mount、remote 服务取用、slot 注册、getConfig/
 * setConfig 包装与按 code 本地化、以及顶层兜底边界（卡死时不炸宿主）。
 *
 * remote 贡献来自构建期生成的 ./remote 工件（CI `bun run test` 会先 build）；
 * 这里 mock 成任意对象，专注入口自身的编排逻辑，避免测试绑定生成物内容。
 */
vi.mock("@chaoset/sandbox-extra-roots/remote", () => ({
  default: { namespace: "sandboxExtraRootsConfig", mocked: true },
}))

import { apply, inject } from "../client/index.js"

/** 生成工件的 RemoteResult 线形（与 client/index.tsx 内部约定一致）。 */
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

function failure(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

interface ClientCtxOptions {
  mountError?: Error
  missingService?: boolean
  registerError?: Error
  configService?: {
    get: () => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>
    set: (partial: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>
  }
}

function makeClientCtx(options: ClientCtxOptions = {}): any {
  const disposers: Array<() => void> = []
  const localeDispose = vi.fn()
  const localeRegister = vi.fn((): (() => void) => {
    if (options.registerError !== undefined) throw options.registerError
    return localeDispose
  })
  const slotsRegister = vi.fn()
  const slotsInject = vi.fn((_slot: string, fn: () => void) => fn())
  const remoteMount = vi.fn(async (_contribution: unknown) => {
    if (options.mountError !== undefined) throw options.mountError
  })
  const configService = options.configService ?? {
    get: async () => ok({ config: { extraWritableRoots: [] } }),
    set: async () => ok({ saved: true }),
  }
  const ctx: any = {
    localeDispose,
    localeRegister,
    slotsRegister,
    slotsInject,
    remoteMount,
    locale: {
      // 用真实 zh 字典：断言用户可见文案（含 {message} 模板替换）。
      bind: (_ns: string) => (key: string) => (zh as Record<string, string>)[key] ?? key,
      register: localeRegister,
    },
    effect(fn: () => void | (() => void)) {
      const dispose = fn()
      if (typeof dispose === "function") disposers.push(dispose)
      return dispose
    },
    remote: { $mount: remoteMount },
    get: (name: string) => {
      if (name !== "remote.sandboxExtraRootsConfig") return undefined
      return options.missingService === true ? undefined : configService
    },
    slots: { inject: slotsInject, register: slotsRegister },
    _disposers: disposers,
  }
  return ctx
}

/** 取 slot 注册的 descriptor（apply 成功后应恰好一个）。 */
function registeredDescriptor(ctx: any): any {
  expect(ctx.slotsRegister).toHaveBeenCalledTimes(1)
  return ctx.slotsRegister.mock.calls[0]?.[0]
}

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

beforeEach(() => {
  consoleError.mockClear()
})

afterEach(() => {
  consoleError.mockClear()
})

describe("client/index.tsx（jsdom）", () => {
  it("导出 inject = ['slots','locale','remote']", () => {
    expect(inject).toEqual(["slots", "locale", "remote"])
  })

  it("apply：注册 locale 字典（disposer 交回 effect）、mount 贡献、注册 keyed slot", async () => {
    const ctx = makeClientCtx()
    await apply(ctx)

    expect(ctx.localeRegister).toHaveBeenCalledWith(NS, { zh: expect.any(Object), en: expect.any(Object) })
    expect(ctx.remoteMount).toHaveBeenCalledWith({ namespace: "sandboxExtraRootsConfig", mocked: true })
    expect(ctx.slotsInject).toHaveBeenCalledWith("plugins.bundle.config", expect.any(Function))

    const descriptor = registeredDescriptor(ctx)
    expect(descriptor.name).toBe("plugins.bundle.config")
    expect(descriptor.key).toBe("@chaoset/sandbox-extra-roots")
    expect(descriptor.locale).toBe(NS)
    const face = descriptor.inject()
    expect(typeof face.getConfig).toBe("function")
    expect(typeof face.setConfig).toBe("function")
    // 卸载时 locale 字典 disposer 被调用（不再丢弃）。
    ctx._disposers.forEach((dispose: () => void) => dispose())
    expect(ctx.localeDispose).toHaveBeenCalledTimes(1)
  })

  it("getConfig 返回整个 get 结果（含 degraded），不是只取 config", async () => {
    const ctx = makeClientCtx({
      configService: {
        get: async () => ok({ config: { extraWritableRoots: ["/tmp/a"] }, degraded: { reason: "policy unavailable" } }),
        set: async () => ok({ saved: true }),
      },
    })
    await apply(ctx)
    const value = await registeredDescriptor(ctx).inject().getConfig()
    expect(value.config.extraWritableRoots).toEqual(["/tmp/a"])
    expect(value.degraded).toEqual({ reason: "policy unavailable" })
  })

  it("getConfig 失败抛技术文本（卡片负责前缀本地化）", async () => {
    const ctx = makeClientCtx({
      configService: {
        get: async () => failure("gateway/internal", "boom"),
        set: async () => ok({ saved: true }),
      },
    })
    await apply(ctx)
    await expect(registeredDescriptor(ctx).inject().getConfig()).rejects.toThrow(
      "sandboxExtraRootsConfig.get failed: gateway/internal: boom",
    )
  })

  it("setConfig 成功返回 value", async () => {
    const ctx = makeClientCtx()
    await apply(ctx)
    await expect(registeredDescriptor(ctx).inject().setConfig({ extraWritableRoots: ["/tmp/a"] })).resolves.toEqual({ saved: true })
  })

  it("setConfig 失败：config-unavailable → 本地化文案", async () => {
    const ctx = makeClientCtx({
      configService: {
        get: async () => ok({ config: { extraWritableRoots: [] } }),
        set: async () => failure("sandbox-extra-roots/config-unavailable", "no config editor"),
      },
    })
    await apply(ctx)
    await expect(registeredDescriptor(ctx).inject().setConfig({})).rejects.toThrow(zh.saveConfigUnavailable)
  })

  it("setConfig 失败：invalid-config → 本地化模板 + 技术细节（函数替换防 $& 注入）", async () => {
    const ctx = makeClientCtx({
      configService: {
        get: async () => ok({ config: { extraWritableRoots: [] } }),
        set: async () => failure("sandbox-extra-roots/invalid-config", "refusing root $& /"),
      },
    })
    await apply(ctx)
    // 模板替换为字面技术文本：$& 不能被当成替换模式展开。
    await expect(registeredDescriptor(ctx).inject().setConfig({})).rejects.toThrow(
      "配置校验失败：refusing root $& /",
    )
  })

  it("setConfig 失败：未知 code 回退 code + 技术文本", async () => {
    const ctx = makeClientCtx({
      configService: {
        get: async () => ok({ config: { extraWritableRoots: [] } }),
        set: async () => failure("gateway/internal", "boom"),
      },
    })
    await apply(ctx)
    await expect(registeredDescriptor(ctx).inject().setConfig({})).rejects.toThrow(
      "sandboxExtraRootsConfig.set failed: gateway/internal: boom",
    )
  })

  it("$mount 失败：不注册 slot，console.error 兜底（不炸宿主）", async () => {
    const ctx = makeClientCtx({ mountError: new Error("mount failed") })
    await expect(apply(ctx)).resolves.toBeUndefined()
    expect(ctx.slotsInject).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      "[sandbox-extra-roots] client card failed to load (settings card missing):",
      expect.any(Error),
    )
  })

  it("mount 后服务不存在：报错兜底，不注册 slot", async () => {
    const ctx = makeClientCtx({ missingService: true })
    await expect(apply(ctx)).resolves.toBeUndefined()
    expect(ctx.slotsInject).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledTimes(1)
    const message = String(consoleError.mock.calls[0]?.[1])
    expect(message).toContain("did not materialize after mount")
  })

  it("locale 注册抛错：入口兜底，不注册 slot", async () => {
    const ctx = makeClientCtx({ registerError: new Error("duplicate namespace") })
    await expect(apply(ctx)).resolves.toBeUndefined()
    expect(ctx.slotsInject).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledTimes(1)
  })
})
