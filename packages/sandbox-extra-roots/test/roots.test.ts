import { describe, expect, it } from "vitest"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { canon, classifyRoot } from "../src/roots.js"

/**
 * roots.ts 的风险分类直接测试：reject（/、盘根、home 本体及祖先）与 filter
 * （系统目录及其词法祖先）两级口径，以及它们对正常业务根/后代不误判。
 *
 * 路径取运行时值（homedir/dirname），平台无关；macOS 的 /private canonical
 * 祖先单独判平台。
 */
describe("classifyRoot", () => {
  it("文件系统根与 Windows 盘根 → reject", () => {
    expect(classifyRoot("/")).toBe("reject")
    expect(classifyRoot("C:")).toBe("reject")
    expect(classifyRoot("C:\\")).toBe("reject")
    expect(classifyRoot("c:/")).toBe("reject")
  })

  it("用户主目录本体与词法祖先 → reject（覆盖 home ancestor 分支）", () => {
    const home = homedir()
    expect(classifyRoot(home)).toBe("reject")
    expect(classifyRoot(canon(home))).toBe("reject")
    const homeParent = dirname(home)
    expect(classifyRoot(homeParent)).toBe("reject")
  })

  it("系统目录 → filter", () => {
    for (const dir of ["/etc", "/usr", "/bin", "/sbin"]) {
      expect(classifyRoot(dir)).toBe("filter")
    }
  })

  it("系统目录的后代是正常业务根（不误判）", () => {
    expect(classifyRoot("/usr/local")).toBeNull()
    expect(classifyRoot("/etc/nginx")).toBeNull()
  })

  it("普通目录 → null", () => {
    expect(classifyRoot("/opt/tool-cache")).toBeNull()
    expect(classifyRoot("/tmp/ser-root")).toBeNull()
  })

  it.skipIf(process.platform !== "darwin")("macOS：系统目录的 canonical 祖先（/private）→ filter", () => {
    expect(classifyRoot("/private")).toBe("filter")
  })
})
