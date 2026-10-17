import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 等待预算回归：每个 vi.waitFor 都要显式声明 timeout。
 *
 * 2026-10-08 建立：vi.waitFor 的**默认超时是 1s**，而 vitest 的 testTimeout 是 30s。测试里的
 * waitFor 覆盖的多是真实 I/O（插件注册、目录刷新、探针跑完），并行负载下 1s 可能不够——
 * usage.test.ts 就因此出现过偶发失败（真正的根因是等待条件偏弱，已另修，但预算偏紧是同类风险）。
 *
 * 判据：每个 vi.waitFor(...) 调用的参数里必须出现 timeout。调用可能跨多行，因此这里用**括号
 * 配对**取整段实参（字符串字面量内的括号不计入），而不是按行 grep——按行统计会漏掉跨行回调。
 */

/** 本文件的文档注释里写了示例，不该被自己的规则扫到。 */
const SELF = fileURLToPath(import.meta.url);
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/**
 * 允许不写 timeout 的调用：\`文件::行号\` → 理由。
 * 目前为空——统一显式声明更省心（默认值偏紧且容易被忽略）。
 */
const ALLOWED: Readonly<Record<string, string>> = {};

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const NEEDLE = "vi.waitFor(";

/** 每个 waitFor 的实参片段（括号配对，字符串字面量内的括号不计入）。 */
function waitForCalls(text: string): { body: string; line: number }[] {
  const calls: { body: string; line: number }[] = [];
  let index = 0;
  for (;;) {
    const start = text.indexOf(NEEDLE, index);
    if (start === -1) break;
    let cursor = start + NEEDLE.length;
    let depth = 1;
    let quote: string | undefined;
    while (cursor < text.length && depth > 0) {
      const char = text[cursor] as string;
      if (quote !== undefined) {
        if (char === "\\") cursor += 2;
        else {
          if (char === quote) quote = undefined;
          cursor += 1;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "\u0060") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      cursor += 1;
    }
    calls.push({ body: text.slice(start + NEEDLE.length, cursor - 1), line: text.slice(0, start).split("\n").length });
    index = cursor;
  }
  return calls;
}

describe("等待预算", () => {
  it("每个 vi.waitFor 都显式声明 timeout", () => {
    const offenders: string[] = [];
    for (const file of testFiles(ROOT)) {
      if (file === SELF) continue;
      const text = readFileSync(file, "utf8");
      for (const call of waitForCalls(text)) {
        if (call.body.includes("timeout")) continue;
        const key = file.replace(ROOT + "/", "") + "::" + call.line;
        if (ALLOWED[key] !== undefined) continue;
        offenders.push(key);
      }
    }
    expect(offenders, "这些 waitFor 没写 timeout（默认 1s 偏紧）：补上预算，或登记到 ALLOWED 并写明理由").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const files = testFiles(ROOT);
    expect(files.length).toBeGreaterThanOrEqual(40);
    const total = files.reduce((sum, file) => sum + waitForCalls(readFileSync(file, "utf8")).length, 0);
    expect(total, "waitFor 数量应可观（否则判据空转）").toBeGreaterThanOrEqual(40);
    expect(ALLOWED["__self_check__"]).toBeUndefined();
  });

  it("判据本身有效：括号配对能取到跨行回调", () => {
    const multiline = ["vi.waitFor(", "  () => {", "    expect(x).toBe(1)", "  },", "  { timeout: 1 },", ")"].join("\n");
    const calls = waitForCalls(multiline);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain("timeout");
  });
});
