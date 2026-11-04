import { describe, expect, it } from "vitest"

/**
 * client/styles.ts 在非浏览器环境的降级：没有 document 时不注入、不抛错
 * （宿主/测试的 node 侧导入不应该因为样式模块而崩溃）。
 */
describe("client/styles.ts 非 DOM 环境", () => {
  it("无 document 时导入安全（不注入、不抛错）", async () => {
    expect(typeof document).toBe("undefined")
    await expect(import("../client/styles.js")).resolves.toBeDefined()
  })
})
