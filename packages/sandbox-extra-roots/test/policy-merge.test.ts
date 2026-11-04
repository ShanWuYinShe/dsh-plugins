import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { symbols } from "@deepseek-ai/cordis"
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox"
import type { SandboxPolicyRequest, SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy"
import { policyMerge, rawPolicyService } from "../src/policy-merge.js"
import { createRootsFilter } from "../src/roots-filter.js"
import { canon } from "../src/roots.js"

/**
 * policy-merge 的单元边界（不经 apply）：rawPolicyService 的容错与 registry
 * symbol、安装/还原的 hadOwn vs 原型方法两种还原姿态、引用计数、update 换根、
 * 以及 install 的契约漂移 fail-loud（resolve 不是函数）。
 */

const made: string[] = []

function tempDir(prefix: string): string {
  const dir = canon(mkdtempSync(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function deps(warnings: string[] = []) {
  return { rootsFilter: createRootsFilter(), warn: (message: string) => warnings.push(message) }
}

/** 原型方法形态的服务（还原应走 Reflect.deleteProperty，而非赋值）。 */
class PrototypePolicy {
  workspaceRoot = "/ws"
  resolve(_request?: SandboxPolicyRequest): SandboxExecutionPolicy {
    return { mode: "workspace-write", workspaceRoot: this.workspaceRoot }
  }
}

describe("rawPolicyService", () => {
  it("undefined / null 明确报错（不是静默跳过）", () => {
    expect(() => rawPolicyService(undefined)).toThrow(/ctx\.sandboxPolicy is unavailable/)
    expect(() => rawPolicyService(null as unknown as undefined)).toThrow(/ctx\.sandboxPolicy is unavailable/)
  })

  it("沿官方 symbols.original 取底层 service（tracer/proxy 场景）", () => {
    const original = { resolve: () => ({ mode: "workspace-write", workspaceRoot: "/ws" }) } as unknown as SandboxPolicyService
    const observed = Object.create(original) as SandboxPolicyService
    Object.defineProperty(observed, symbols.original, { value: original })
    expect(rawPolicyService(observed)).toBe(original)
  })

  it("普通 service 原样返回", () => {
    const service = new PrototypePolicy() as unknown as SandboxPolicyService
    expect(rawPolicyService(service)).toBe(service)
  })
})

describe("policyMerge 安装/还原边界", () => {
  it("原型方法形态：包装为自有属性，释放后删除自有属性恢复原型方法", () => {
    const service = new PrototypePolicy() as unknown as SandboxPolicyService
    const original = service.resolve
    const merge = policyMerge(service, deps())
    const release = merge.mount()
    merge.install()
    expect(Object.hasOwn(service, "resolve")).toBe(true)
    expect(service.resolve).not.toBe(original)
    release()
    // Reflect.deleteProperty 分支：自有包装消失，原型方法重新可见（同一函数）。
    expect(Object.hasOwn(service, "resolve")).toBe(false)
    expect(service.resolve).toBe(original)
  })

  it("自有方法形态：释放时赋回原实现（hadOwn 分支）", () => {
    const originalResolve = (): SandboxExecutionPolicy => ({ mode: "workspace-write", workspaceRoot: "/ws" })
    const service = { resolve: originalResolve } as unknown as SandboxPolicyService
    const merge = policyMerge(service, deps())
    const release = merge.mount()
    merge.install()
    expect(service.resolve).not.toBe(originalResolve)
    release()
    expect(service.resolve).toBe(originalResolve)
  })

  it("install 幂等；重复 mount 只还原一次", () => {
    const service = new PrototypePolicy() as unknown as SandboxPolicyService
    const original = service.resolve
    const merge = policyMerge(service, deps())
    const releaseA = merge.mount()
    const releaseB = merge.mount()
    merge.install()
    merge.install()
    releaseA()
    // 仍有 B 挂载：包装保留。
    expect(service.resolve).not.toBe(original)
    releaseB()
    expect(service.resolve).toBe(original)
  })

  it("update 换根后下一次 resolve 使用新配置", () => {
    const first = tempDir("ser-pm-first-")
    const second = tempDir("ser-pm-second-")
    const service = new PrototypePolicy() as unknown as SandboxPolicyService
    const merge = policyMerge(service, deps())
    const release = merge.mount()
    merge.update([first], createRootsFilter(), () => {})
    merge.install()
    expect(service.resolve().additionalWritableRoots).toEqual([canon(first)])
    merge.update([second], createRootsFilter(), () => {})
    expect(service.resolve().additionalWritableRoots).toEqual([canon(second)])
    release()
  })

  it("resolve 不是函数：install 直接抛错（契约漂移 fail loud）", () => {
    const service = { resolve: undefined } as unknown as SandboxPolicyService
    const merge = policyMerge(service, deps())
    expect(() => merge.install()).toThrow(/resolve is not a function/)
    // 未安装 → 释放只清状态，不会去还原不存在的包装。
    expect(() => merge.mount()()).not.toThrow()
  })

  it("未安装就释放：不破坏原 service，也不留下状态残留", () => {
    const service = new PrototypePolicy() as unknown as SandboxPolicyService
    const original = service.resolve
    const merge = policyMerge(service, deps())
    const release = merge.mount()
    release()
    expect(service.resolve).toBe(original)
    // 再次取句柄仍可用（状态已清理，重新建立）。
    const again = policyMerge(service, deps())
    const releaseAgain = again.mount()
    again.install()
    expect(service.resolve).not.toBe(original)
    releaseAgain()
    expect(service.resolve).toBe(original)
  })
})
