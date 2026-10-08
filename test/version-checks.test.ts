import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION_RE,
  compareVersions,
  findChangelogSection,
  isPrerelease,
  isStable,
} from "../scripts/lib/version-checks.mjs";

/**
 * 发布关键纯逻辑的直接测试（semver 判定与 CHANGELOG 小节查找）。
 *
 * 2026-10-08 补：这个模块被发布门禁、Release 说明提取、基线核对、宿主适配四处共用——它被提取
 * 出来的原因就是**四份手抄发生过真实漂移**（adapt-dsh 的 \\w+ 口径曾放行非法 semver）。既然是
 * 发布链路上的判据，就该有直接断言，而不是只靠跑一遍门禁。
 *
 * 下面几条用例直接来自注释里记录过的真实事故。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("类型声明与实现一致", () => {
  it("version-checks.d.mts 的导出面与实现一致（防止声明漂移）", async () => {
    const actual = Object.keys(await import("../scripts/lib/version-checks.mjs")).sort();
    const declared = [...readFileSync(join(ROOT, "scripts/lib/version-checks.d.mts"), "utf8")
      .matchAll(/export declare (?:const|function) (\w+)/g)].map((match) => match[1] as string).sort();
    expect(actual).toEqual(declared);
  });
});

describe("VERSION_RE", () => {
  it("接受正式版、prerelease 与 build metadata", () => {
    for (const ok of ["1.2.3", "0.4.14-alpha.4", "1.0.0-rc.1+build.5", "0.0.0"]) {
      expect(VERSION_RE.test(ok), ok).toBe(true);
    }
  })

  it("拒绝缺段、多段、前缀 v 与空串", () => {
    for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "", "1.2.3-", "abc"]) {
      expect(VERSION_RE.test(bad), bad).toBe(false)
    }
  })

  it("回归：下划线不属于合法 prerelease 字符（曾用 \\w+ 放行过）", () => {
    expect(VERSION_RE.test("1.2.3-alpha_1")).toBe(false)
  })
})

describe("compareVersions", () => {
  it("主/次/补丁按数值比较", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0)
    expect(compareVersions("1.3.0", "1.2.9")).toBeGreaterThan(0)
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0)
    expect(compareVersions("1.2.3", "1.2.10")).toBeLessThan(0) // 数值而非字典序
  })

  it("带 prerelease 的小于同号正式版", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0")).toBeLessThan(0)
    expect(compareVersions("1.0.0", "1.0.0-alpha")).toBeGreaterThan(0)
  })

  it("数字标识符小于字母标识符", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0)
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0)
  })

  it("回归：标识符段数呈前缀关系时少者更小", () => {
    expect(compareVersions("0.3.14-alpha", "0.3.14-alpha.1")).toBeLessThan(0)
    expect(compareVersions("0.3.14-alpha.1", "0.3.14-alpha")).toBeGreaterThan(0)
  })

  it("字母标识符按字典序", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0)
  })

  it("build metadata 不参与比较", () => {
    expect(compareVersions("1.0.0+a", "1.0.0+b")).toBe(0)
    expect(compareVersions("1.0.0-rc.1+a", "1.0.0-rc.1+b")).toBe(0)
  })
})

describe("isPrerelease / isStable", () => {
  it("出现第一个 - 即 prerelease，不看标识符内容", () => {
    expect(isPrerelease("0.4.14-alpha.4")).toBe(true)
    expect(isPrerelease("1.0.0-1")).toBe(true)
    expect(isPrerelease("0.4.14")).toBe(false)
    expect(isStable("0.4.14")).toBe(true)
    expect(isStable("0.4.14-rc.1")).toBe(false)
  })
})

describe("findChangelogSection", () => {
  const lines = ["# 更新日志", "", "## 0.4.14-alpha.4", "- 修复", "## 0.4.5-beta", "## 1.0.0 ", "- 正式"];

  it("找到标题行索引", () => {
    expect(findChangelogSection(lines, "0.4.14-alpha.4")).toBe(2)
    expect(findChangelogSection(lines, "1.0.0")).toBe(5) // 允许标题后带空格
  })

  it("没有该版本时返回 -1", () => {
    expect(findChangelogSection(lines, "9.9.9")).toBe(-1)
  })

  it("回归：带空格边界，不会把 0.4.5-beta 当成 0.4.5 的小节", () => {
    expect(findChangelogSection(lines, "0.4.5")).toBe(-1)
  })
})
