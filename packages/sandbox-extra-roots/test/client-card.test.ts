/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { SandboxRootsCard } from "../client/SandboxRootsCard.js"
import { zh } from "../client/locales.js"
import type { SandboxExtraRootsGetResult, SandboxExtraRootsSetRequest } from "../src/types.js"

/**
 * 设置卡片的 jsdom 行为测试（RULE-087）：展开/读配置/保存/校验禁用/
 * 错误态/降级横幅。此前只有 roots-preview 纯函数测试，组件行为零覆盖。
 *
 * 用 react-dom/client + React.act 直接渲染真实组件（不引入测试库）；
 * 文案用 locales 的 zh 字典，断言用户可见文本而不是内部 key。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

function props(overrides: Record<string, unknown> = {}): any {
  return {
    view: "page",
    t,
    getConfig: vi.fn(async (): Promise<SandboxExtraRootsGetResult> => ({ config: { extraWritableRoots: [] } })),
    setConfig: vi.fn(async (_: SandboxExtraRootsSetRequest) => ({ saved: true })),
    ...overrides,
  }
}

async function render(p: any): Promise<void> {
  await act(async () => {
    root.render(React.createElement(SandboxRootsCard, p))
  })
}

/** 展开卡片并等待 getConfig 的 effect 落定。 */
async function open(p: any): Promise<void> {
  await render(p)
  const header = container.querySelector(".ser_header")
  if (header === null) throw new Error("card header not rendered")
  await act(async () => {
    header.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

function textarea(): HTMLTextAreaElement {
  const element = container.querySelector("textarea")
  if (element === null) throw new Error("textarea not rendered")
  return element as HTMLTextAreaElement
}

function typeText(value: string): void {
  const element = textarea()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
  if (setter === undefined) throw new Error("HTMLTextAreaElement value setter missing")
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new window.Event("input", { bubbles: true }))
  })
}

function button(selector: string): HTMLButtonElement {
  const element = container.querySelector(selector)
  if (element === null) throw new Error(`button ${selector} not rendered`)
  return element as HTMLButtonElement
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  })
}

describe("SandboxRootsCard（jsdom）", () => {
  it("summary 视图只渲染一句话，不读配置", async () => {
    const p = props({ view: "summary" })
    await render(p);
    expect(container.textContent).toContain(zh.summary)
    expect(p.getConfig).not.toHaveBeenCalled()
  })

  it("展开后读取配置并填入 textarea/计数", async () => {
    const p = props({
      getConfig: vi.fn(async (): Promise<SandboxExtraRootsGetResult> => ({
        config: { extraWritableRoots: ["/tmp/a", "/tmp/b"] },
      })),
    })
    await open(p)
    expect(p.getConfig).toHaveBeenCalledTimes(1)
    expect(textarea().value).toBe("/tmp/a\n/tmp/b")
    expect(container.textContent).toContain("共 2 个目录")
  })

  it("编辑后保存：把解析出的根交给 setConfig，并展示已保存提示", async () => {
    const p = props();
    await open(p)
    typeText("/tmp/a\n\n/tmp/b  \n")
    await click(button(".ser_save"))
    expect(p.setConfig).toHaveBeenCalledWith({ extraWritableRoots: ["/tmp/a", "/tmp/b"] })
    expect(container.textContent).toContain(zh.saved)
  })

  it("非法行（相对路径）标出问题并禁用保存", async () => {
    const p = props();
    await open(p)
    typeText("relative/path")
    expect(container.textContent).toContain("不是绝对路径")
    expect(button(".ser_save").disabled).toBe(true)
    await click(button(".ser_save"))
    expect(p.setConfig).not.toHaveBeenCalled()
  })

  it("读配置失败展示 role=alert 错误态", async () => {
    const p = props({
      getConfig: vi.fn(async () => {
        throw new Error("gateway down")
      }),
    })
    await open(p)
    const alert = container.querySelector("[role=alert]")
    expect(alert?.textContent).toContain(zh.loadFailed)
    expect(alert?.textContent).toContain("gateway down")
  })

  it("保存失败展示 role=alert 错误态", async () => {
    const p = props({
      setConfig: vi.fn(async () => {
        throw new Error("config-editor unavailable")
      }),
    })
    await open(p)
    typeText("/tmp/a")
    await click(button(".ser_save"))
    const alert = container.querySelector("[role=alert]")
    expect(alert?.textContent).toContain(zh.saveFailed)
    expect(alert?.textContent).toContain("config-editor unavailable")
  })

  it("degraded: enforcement 未生效时在卡片顶部展示原因（SB-12）", async () => {
    const p = props({
      getConfig: vi.fn(async (): Promise<SandboxExtraRootsGetResult> => ({
        config: { extraWritableRoots: ["/tmp/a"] },
        degraded: { reason: "ctx.sandboxPolicy is unavailable" },
      })),
    })
    await open(p)
    const alert = container.querySelector("[role=alert]")
    expect(alert?.textContent).toContain("额外可写根当前未生效")
    expect(alert?.textContent).toContain("ctx.sandboxPolicy is unavailable")
  })

  it("预设 chip：一键追加一行并清掉过期的已保存提示", async () => {
    const p = props()
    await open(p)
    const chips = [...container.querySelectorAll(".ser_action")] as HTMLButtonElement[]
    expect(chips.length).toBeGreaterThan(0)
    const preset = chips[0]!
    const presetPath = preset.textContent ?? ""
    expect(presetPath.length).toBeGreaterThan(0)
    await click(preset)
    expect(textarea().value.split("\n")).toContain(presetPath)
    expect(button(".ser_discard").disabled).toBe(false)
    // 连点同一个预设不重复追加（appendRootLine 幂等）。
    await click(preset)
    expect(textarea().value.split("\n").filter((line) => line === presetPath)).toHaveLength(1)
  })

  it("discard 放弃修改后恢复原值", async () => {
    const p = props({
      getConfig: vi.fn(async (): Promise<SandboxExtraRootsGetResult> => ({
        config: { extraWritableRoots: ["/tmp/a"] },
      })),
    })
    await open(p)
    typeText("/tmp/b")
    expect(button(".ser_discard").disabled).toBe(false)
    await click(button(".ser_discard"))
    expect(textarea().value).toBe("/tmp/a")
    expect(button(".ser_discard").disabled).toBe(true)
  })
})
