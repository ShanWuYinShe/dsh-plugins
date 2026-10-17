import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 文档命令引用回归：文档里写的每条 bun run 命令与 node scripts 调用都要真实存在。
 *
 * 2026-10-08 建立（docs-links 的姊妹锁）：改名/删除一个 script 后，文档里的用法说明
 * 会静默变错——不报错、不影响构建，只有照着文档敲命令的人才发现。这类「没有自然信号
 * 的退化」正是本目录的共同主题。
 *
 * 判据只覆盖两种确定形态：行内代码中的 bun run <脚本名>（含 npm/pnpm run 同形），以及
 * node scripts/<文件>（后面可跟参数，只取文件部分）。bun install / bun x / bun pm pack
 * 是 bun 内建子命令，不在范围内；正文里不带 run 的裸提及（如“跑 gate 看看”）也不在范围内。
 *
 * 真要引用仓库外的命令，登记到 ALLOWED 并写明理由。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/** 允许指向仓库外的命令引用：文件::引用 → 理由。目前为空。 */
const ALLOWED: Readonly<Record<string, string>> = {};

const RUN = /`(?:bun|npm|pnpm)\s+run\s+([a-zA-Z:_-]+)/g;
const NODE_SCRIPT = /`node\s+(scripts\/\S+?)(?:\s|`|$)/g;

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function rootScripts(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  return new Set(Object.keys(pkg.scripts ?? {}));
}

/** node scripts/<文件> 是否指向真实存在的文件（去掉行内代码后的尾随标点）。 */
function scriptResolves(target: string): boolean {
  const path = target.replace(/[.,;:)"]+$/, "");
  if (path === "") return true;
  return existsSync(resolve(ROOT, path));
}

describe("文档命令引用", () => {
  it("每条 bun run 命令都是根 package.json 里真实存在的脚本", () => {
    const scripts = rootScripts();
    const offenders: string[] = [];
    for (const file of markdownFiles(ROOT)) {
      if (file === SELF) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(RUN)) {
        const name = match[1] as string;
        if (scripts.has(name)) continue;
        const key = file.replace(ROOT + "/", "") + "::bun run " + name;
        if (ALLOWED[key] !== undefined) continue;
        offenders.push(key);
      }
    }
    expect(offenders, "这些文档命令指向不存在的脚本：改文档，或登记到 ALLOWED 并写明理由").toEqual([]);
  });

  it("每个 node scripts/<文件> 调用都指向真实存在的文件", () => {
    const offenders: string[] = [];
    for (const file of markdownFiles(ROOT)) {
      if (file === SELF) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(NODE_SCRIPT)) {
        const target = (match[1] ?? "").trim();
        if (scriptResolves(target)) continue;
        const key = file.replace(ROOT + "/", "") + "::" + target;
        if (ALLOWED[key] !== undefined) continue;
        offenders.push(key);
      }
    }
    expect(offenders, "这些文档调用指向不存在的脚本文件：改文档，或登记到 ALLOWED 并写明理由").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const files = markdownFiles(ROOT);
    expect(files.length).toBeGreaterThanOrEqual(8);
    let runs = 0;
    let nodes = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      runs += [...text.matchAll(RUN)].length;
      nodes += [...text.matchAll(NODE_SCRIPT)].length;
    }
    expect(runs, "bun run 引用数量应可观（否则判据空转）").toBeGreaterThanOrEqual(5);
    expect(nodes, "node scripts 引用至少有一条").toBeGreaterThanOrEqual(1);
    expect(ALLOWED["__self_check__"]).toBeUndefined();
  });

  it("判据本身有效：能识别缺失脚本与缺失文件", () => {
    const scripts = rootScripts();
    expect(scripts.has("test:ci")).toBe(true);
    expect(scripts.has("no-such-script")).toBe(false);
    expect(scriptResolves("scripts/dsh-baseline.mjs")).toBe(true);
    expect(scriptResolves("scripts/does-not-exist.mjs")).toBe(false);
  });
});
