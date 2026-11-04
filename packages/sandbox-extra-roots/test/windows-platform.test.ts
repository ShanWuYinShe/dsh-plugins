import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox"
import { apply } from "../src/index.js"
import { canon } from "../src/roots.js"

/**
 * Windows 平台护栏：官方 win32 链只有 windows-acl runner，而 rc.1 的
 * @deepseek-ai/dsh-sandbox-local 在 `windowsAclRunnerArgv` 里对
 * workspace-write + additionalWritableRoots 显式抛 SandboxUnsupportedPolicyError
 * （lib/index.js windowsAclRunnerArgv）。本插件因此在该平台不并入配置根，
 * 并降级为「可见的未生效」，避免每条受限命令都失败。
 *
 * 平台用 getter 打桩（与宿主侧测试一致），用例结束恢复真实平台。
 */

const realPlatform = process.platform
const platformSpy = vi.spyOn(process, "platform", "get")

const made: string[] = []

function tempDir(prefix: string): string {
  const dir = canon(mkdtempSync(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}

afterEach(() => {
  platformSpy.mockReturnValue(realPlatform)
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakePolicy {
  resolve(request?: unknown): SandboxExecutionPolicy
}

/** 原型方法形态：护栏不安装包装时可断言"没有自有 resolve 属性"。 */
class PrototypePolicy implements FakePolicy {
  resolve(): SandboxExecutionPolicy {
    return { mode: "workspace-write", workspaceRoot: "/ws" };
  }
}

function makePolicy(): FakePolicy {
  return new PrototypePolicy();
}

function makeCtx(policy: FakePolicy): any {
  const warnings: string[] = []
  const disposers: Array<() => void> = []
  const ctx: any = {
    sandboxPolicy: policy,
    warnings,
    disposers,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
    logger: { warn: (message: string) => warnings.push(message) },
    fiber: { entry: { options: { id: "sandbox-extra-roots" } } },
    get: () => undefined,
    effect(fn: () => void | (() => void)) {
      const dispose = fn()
      if (typeof dispose === "function") disposers.push(dispose)
      return dispose
    },
    plugin(Cls: any, cfg: any) {
      const saved = this.reflect
      this.reflect = { provide: () => {}, props: {} }
      try {
        this.gateway = new Cls(this, cfg)
      } finally {
        this.reflect = saved
      }
    },
  }
  return ctx
}

describe("Windows ACL 平台护栏", () => {
  it("win32 + 配置了额外根：不并入官方 policy，降级原因可见", async () => {
    platformSpy.mockReturnValue("win32")
    const extra = tempDir("ser-win-extra-")
    const policy = makePolicy()
    const ctx = makeCtx(policy)
    await apply(ctx, { extraWritableRoots: [extra] })

    // 官方 policy 完全不变（不注入 additionalWritableRoots → 不会触发官方
    // SandboxUnsupportedPolicyError），也不安装 resolve 包装。
    expect(policy.resolve().additionalWritableRoots).toBeUndefined()
    expect(Object.hasOwn(policy, "resolve")).toBe(false);

    const result = ctx.gateway.get()
    expect(result.degraded?.reason).toMatch(/Windows ACL/)
    expect(result.config.extraWritableRoots).toEqual([extra])
    expect(ctx.warnings.some((w: string) => w.includes("NOT in effect"))).toBe(true)
  })

  it("win32 未配置额外根：正常生效（无降级、无警告）", async () => {
    platformSpy.mockReturnValue("win32")
    const policy = makePolicy()
    const ctx = makeCtx(policy)
    await apply(ctx, { extraWritableRoots: [] })
    expect(ctx.gateway.get().degraded).toBeUndefined()
    expect(policy.resolve().additionalWritableRoots).toBeUndefined()
    expect(ctx.warnings.filter((w: string) => w.includes("NOT in effect"))).toHaveLength(0)
  })

  it("非 win32 平台照常并入（护栏不误伤 macOS/Linux）", async () => {
    platformSpy.mockReturnValue("linux")
    const extra = tempDir("ser-lin-extra-")
    const policy = makePolicy()
    const ctx = makeCtx(policy)
    await apply(ctx, { extraWritableRoots: [extra] })
    expect(ctx.gateway.get().degraded).toBeUndefined()
    expect(policy.resolve().additionalWritableRoots).toEqual([canon(extra)])
    ctx.disposeAll()
    expect(policy.resolve().additionalWritableRoots).toBeUndefined()
  })
})
