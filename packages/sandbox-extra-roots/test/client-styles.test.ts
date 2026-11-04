/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * client/styles.ts 的注入行为（此前 0% 覆盖）：首次求值插入 `data-plugin-css`
 * 去重标记的 <style>，重复求值（HMR/module 重新执行）不会重复插入。
 */

const CSS_TAG_ID = "@chaoset/sandbox-extra-roots/client.css"
const SELECTOR = `style[data-plugin-css="${CSS_TAG_ID}"]`

afterEach(() => {
  for (const node of document.head.querySelectorAll('style[data-plugin]')) node.remove()
  vi.resetModules()
})

describe("client/styles.ts 样式注入（jsdom）", () => {
  it("首次求值插入样式表并打上去重标记", async () => {
    await import("../client/styles.js")
    const tags = document.querySelectorAll(SELECTOR)
    expect(tags).toHaveLength(1)
    const tag = tags[0] as HTMLStyleElement
    expect(tag.dataset.plugin).toBe("@chaoset/sandbox-extra-roots")
    expect(tag.textContent).toContain(".ser_card")
    // 关键规则随产物存在（hover 门控与 reduced-motion 收敛）。
    expect(tag.textContent).toContain("@media (hover:hover)")
    expect(tag.textContent).toContain("prefers-reduced-motion")
  })

  it("模块重新执行（HMR）不重复插入", async () => {
    await import("../client/styles.js")
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(1)
    // resetModules 后再次求值：querySelector 命中已有标记 → 跳过插入。
    vi.resetModules()
    await import("../client/styles.js")
    expect(document.querySelectorAll(SELECTOR)).toHaveLength(1)
  })
})
