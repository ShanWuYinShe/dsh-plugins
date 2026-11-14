import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  enginesDshKind,
  enginesDshProblems,
  formatCompatRange,
  nextLineOf,
  parseCompatRange,
} from "../scripts/lib/engines-compat.mjs";

/**
 * engines.dsh 兼容声明形态与发布期校验的直接测试（scripts/lib/engines-compat.mjs）。
 *
 * 这个模块是 adapt-dsh（写声明）、dsh-baseline（发布门禁）、dsh-follow-status（状态核对）、
 * dsh-deps / plugin-market-core（声明解析与索引收录）共用的单一判据来源。这里同时用真实
 * semver 验证「上界必须写 -0」这一宿主判定口径：宿主按 includePrerelease 判定，
 * <0.2.3 会放过 0.2.3-alpha.0，只有 <0.2.3-0 能挡住下一线预发布。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const requireForTest = createRequire(import.meta.url);
const semver = requireForTest("semver") as {
  satisfies: (version: string, range: string, options?: { includePrerelease?: boolean }) => boolean;
};

const BASELINE = "0.2.2-rc.3";
const FLOOR = "0.2.2-rc.2";
const COMPAT = ">=0.2.2-rc.2 <0.2.3-0";

describe("类型声明与实现一致", () => {
  it("engines-compat.d.mts 的导出面与实现一致（防止声明漂移）", async () => {
    const actual = Object.keys(await import("../scripts/lib/engines-compat.mjs")).sort();
    const declared = [...readFileSync(join(ROOT, "scripts/lib/engines-compat.d.mts"), "utf8")
      .matchAll(/export declare (?:const|function) (\w+)/g)].map((match) => match[1] as string).sort();
    expect(actual).toEqual(declared);
  });
});

describe("nextLineOf", () => {
  it("DSH 宿主线 = 完整 X.Y.Z 基础号，下一线是补丁号 +1", () => {
    expect(nextLineOf("0.2.2-rc.3")).toBe("0.2.3");
    expect(nextLineOf("0.2.2")).toBe("0.2.3");
    expect(nextLineOf("1.0.0")).toBe("1.0.1");
  });
});

describe("formatCompatRange", () => {
  it("生成严格形态：下界原样、上界固定为下一线 -0", () => {
    expect(formatCompatRange(BASELINE, FLOOR)).toBe(COMPAT);
    expect(formatCompatRange("0.2.2-rc.4", FLOOR)).toBe(">=0.2.2-rc.2 <0.2.3-0");
  });

  it("非法 semver 直接抛错（防御误用，不产出坏声明）", () => {
    expect(() => formatCompatRange("0.2.2", "rc.2")).toThrow();
    expect(() => formatCompatRange("latest", "0.2.2-rc.2")).toThrow();
  });
});

describe("parseCompatRange", () => {
  it("接受严格形态并拆出下界与下一线", () => {
    expect(parseCompatRange(COMPAT)).toEqual({ floor: FLOOR, nextLine: "0.2.3" });
    expect(parseCompatRange("  >=0.2.2-rc.2   <0.2.3-0  ")).toEqual({ floor: FLOOR, nextLine: "0.2.3" });
  });

  it("拒绝一切非严格形态（宽松范围归历史 pin 口径，不走兼容范围）", () => {
    const bad = [
      "0.2.2-rc.3",
      "^0.2.2-rc.2",
      "~0.2.2-rc.2",
      ">=0.2.2-rc.2",
      ">=0.2.2-rc.2 <0.2.3",
      ">=0.2.2-rc.2 <0.2.3-1",
      ">=0.2.2-rc.2 <=0.2.3-0",
      "0.2.2-rc.2 - 0.2.2",
      "*",
      "latest",
      "0.2.2-rc.2 || 0.2.3-rc.1",
      "",
      42,
      undefined,
    ];
    for (const value of bad) expect(parseCompatRange(value), String(value)).toBeUndefined();
  });
});

describe("enginesDshKind", () => {
  it("分类精确版本 / 同线兼容范围 / 非法", () => {
    expect(enginesDshKind(BASELINE)).toBe("exact");
    expect(enginesDshKind(" 0.2.2 ")).toBe("exact");
    expect(enginesDshKind(COMPAT)).toBe("compat");
    for (const value of ["^0.2.2-rc.2", ">=0.2.2-rc.2", "*", "", 42, undefined]) {
      expect(enginesDshKind(value), String(value)).toBe("invalid");
    }
  });
});

describe("enginesDshProblems（发布包口径）", () => {
  it("精确等于构建基线 → 通过", () => {
    expect(enginesDshProblems(BASELINE, BASELINE)).toEqual([]);
  });

  it("覆盖构建基线的同线兼容范围 → 通过", () => {
    expect(enginesDshProblems(COMPAT, BASELINE)).toEqual([]);
    expect(enginesDshProblems(">=0.2.2-rc.2 <0.2.3-0", "0.2.2-rc.4")).toEqual([]);
    expect(enginesDshProblems(formatCompatRange(BASELINE, BASELINE), BASELINE)).toEqual([]);
  });

  it("缺失 / 形态非法 → 报问题（文案包含可执行的形态示例）", () => {
    const missing = enginesDshProblems(undefined, BASELINE);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("缺少 engines.dsh");
    const invalid = enginesDshProblems("^0.2.2-rc.2", BASELINE);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain("形态非法");
    expect(invalid[0]).toContain(">=0.2.2-rc.3 <0.2.3-0");
  });

  it("精确声明不等于构建基线 → 报不一致", () => {
    const problems = enginesDshProblems("0.2.2-rc.2", BASELINE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("不一致");
  });

  it("兼容范围上界不是构建基线的下一线 → 报错（含 includePrerelease 提醒）", () => {
    const wider = enginesDshProblems(">=0.2.2-rc.2 <0.2.4-0", BASELINE);
    expect(wider.join("\n")).toContain("上界必须切在构建基线的下一线");
    expect(wider.join("\n")).toContain("includePrerelease");
    // 缺 -0 的写法连严格形态都不算，会落进 invalid。
    expect(enginesDshProblems(">=0.2.2-rc.2 <0.2.3", BASELINE)[0]).toContain("形态非法");
  });

  it("下界跨线或高于基线 → 报错", () => {
    const crossLine = enginesDshProblems(">=0.2.1-rc.5 <0.2.3-0", BASELINE);
    expect(crossLine.join("\n")).toContain("不在同一宿主基础号");
    const tooHigh = enginesDshProblems(">=0.2.2-rc.4 <0.2.3-0", BASELINE);
    expect(tooHigh.join("\n")).toContain("高于构建基线");
  });
});

describe("与宿主真实判定口径一致（semver includePrerelease）", () => {
  const satisfies = (host: string, range: string): boolean => semver.satisfies(host, range, { includePrerelease: true });

  it("兼容范围接受 rc.2 / rc.3，拒绝下一线与更早版本", () => {
    for (const host of ["0.2.2-rc.2", "0.2.2-rc.3", "0.2.2-rc.4"]) {
      expect(satisfies(host, COMPAT), host).toBe(true);
    }
    for (const host of ["0.2.1-rc.5", "0.2.3-alpha.0", "0.2.3-rc.1", "0.2.3", "0.3.0-rc.1"]) {
      expect(satisfies(host, COMPAT), host).toBe(false);
    }
  });

  it("上界不写 -0 会放过下一线预发布（这就是必须写 -0 的原因）", () => {
    expect(satisfies("0.2.3-alpha.0", ">=0.2.2-rc.2 <0.2.3")).toBe(true);
    expect(satisfies("0.2.3-alpha.0", COMPAT)).toBe(false);
  });

  it("精确声明只接受它自己（后向不兼容时的保守形态）", () => {
    expect(satisfies("0.2.2-rc.3", BASELINE)).toBe(true);
    expect(satisfies("0.2.2-rc.2", BASELINE)).toBe(false);
    expect(satisfies("0.2.2-rc.4", BASELINE)).toBe(false);
  });
});
