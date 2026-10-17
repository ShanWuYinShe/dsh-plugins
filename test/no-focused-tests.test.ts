import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 无聚焦/跳过测试回归：测试文件里不许出现 .only / 裸 .skip / .todo。
 *
 * 2026-10-08 建立：it.only 提交上去是最安静的事故——套件照样全绿，只是从
 * 跑 900 个变成跑 3 个，没有任何红灯。裸 .skip（非 skipIf）与 .todo 同理：
 * 占着位置、永远不跑、永远不红。条件跳过 skipIf（平台/环境矩阵，AGENTS.md
 * 要求模式）不在此限——它要么跑要么有明确理由。
 *
 * 精度选择：只认 vitest 自身的 it/describe/test/suite（含 it.concurrent.only
 * 这类链式）；foo.skip() 之类的业务方法不算。行内 // 注释豁免（与卫生锁同口径）；
 * 误伤字符串字面量时（如断言某条报错文本恰好含 .only）走 ALLOWED 登记。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
/** 本文件的自检用例里写了标记示例字符串，不该被自己的规则扫到（各锁同款 SELF 排除）。 */
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/** 误伤登记：文件 → 行号 → 理由。目前为空。 */
const ALLOWED: Readonly<Record<string, Record<number, string>>> = {};

const MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  [".only", /(?:it|describe|test|suite)(?:\.\w+)*\.only\s*\(/],
  [".skip", /(?:it|describe|test|suite)\.skip\s*\(/],
  [".todo", /(?:it|describe|test|suite)\.todo\s*\(/],
];

/** 一行里的聚焦/跳过标记（无则 null）。skipIf 不算（I 紧跟 skip，正则不匹配）。 */
function lineMarker(line: string): string | null {
  for (const [name, pattern] of MARKERS) {
    const match = pattern.exec(line);
    if (match === null) continue;
    if (line.slice(0, match.index).includes("//")) continue;
    return name;
  }
  return null;
}

/** vitest 收集范围内的测试文件（与 vitest.config.ts include 同范围）。 */
function testFiles(): string[] {
  const out: string[] = [];
  const pushDir = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) pushDir(full);
      else if (entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  pushDir(join(ROOT, "test"));
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const testDir = join(ROOT, "packages", entry.name, "test");
    try {
      pushDir(testDir);
    } catch {
      // 没有 test 目录的包：跳过（不是本锁的事）。
    }
  }
  return out.sort();
}

describe("无聚焦测试", () => {
  it("测试文件里没有 .only / 裸 .skip / .todo", () => {
    const offenders: string[] = [];
    for (const file of testFiles()) {
      if (file === SELF) continue;
      const relative = file.replace(ROOT + "/", "");
      const allowed = ALLOWED[relative] ?? {};
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const marker = lineMarker(line);
        if (marker === null) return;
        if (allowed[index + 1] !== undefined) return;
        offenders.push(`${relative}:${index + 1} (${marker})`);
      });
    }
    expect(offenders, "聚焦/跳过标记会让套件静默少跑：删掉（条件跳过请用 skipIf）").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    expect(testFiles().length).toBeGreaterThanOrEqual(85);
  });

  it("判据本身有效：标记识别与豁免", () => {
    expect(lineMarker('it.only("x", () => {});')).toBe(".only");
    expect(lineMarker("  it.concurrent.only(\"x\", () => {});")).toBe(".only");
    expect(lineMarker("describe.skip(\"x\", () => {});")).toBe(".skip");
    expect(lineMarker('it.todo("later");')).toBe(".todo");
    expect(lineMarker("it.skipIf(cond)(\"x\", () => {});")).toBeNull();
    expect(lineMarker("// it.only 绝不能提交")).toBeNull();
    expect(lineMarker('expect(a).toBe(b);')).toBeNull();
  });
});
