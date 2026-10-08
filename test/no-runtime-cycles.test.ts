import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 运行时导入无环回归：packages 星号 src 里的值级导入不能形成环。
 *
 * 2026-10-08 建立：连续 38 个文件的拆分把模块图越拆越密，必须有人盯着
 * “运行时到底有没有环”。tsc 对环不报错、esbuild/vitest 大多能容忍，但 CJS
 * 产物（client.cjs）遇到循环 require 会拿到半初始化模块——而这是安装后才炸的。
 *
 * 判据只看**值级边**（运行时真实存在的导入）：import type / export type 整句、
 * 花括号里全是 type 修饰的 imported/exported（如 import { type X }，
 * verbatimModuleSyntax 下整句擦除），都不算边。类型环无害，误报它只会逼人
 * 做无意义的拆分。副作用导入（import './x.js'）算值边。
 *
 * 精度选择：只匹配**行首**的 import/export 语句。注释掉的导入（// import…、
 * 块注释里的 * import…）行首不是关键字，自然排除——此前多轮审计证明，
 * “扫到注释里的东西”是这类规则最常见的误报来源。静态 import 本来就只能写在
 * 顶层，本仓风格也是顶格写，所以行首锚点不漏报。动态 import() 不在范围内。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

type EdgeKind = "value" | "type";

/** 子句（import/export 与 from 之间的部分）是值还是类型。 */
function statementKind(clause: string): EdgeKind {
  const text = clause.trim();
  if (/^type[\s{]/.test(text)) return "type";
  if (!text.startsWith("{")) return "value";
  const names = text.slice(1, text.lastIndexOf("}")).split(",").map((part) => part.trim()).filter(Boolean);
  if (names.length > 0 && names.every((name) => /^type\s+/.test(name))) return "type";
  return "value";
}

const FROM_RE = /^(?:import|export)\s+([\s\S]*?)\s+from\s+["'](\.[^"']+)["']/;
const SIDE_EFFECT_RE = /^import\s+["'](\.[^"']+)["']/;

function resolveTarget(specifier: string, fromFile: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.endsWith(".js") ? base.slice(0, -3) : base;
  for (const candidate of [stem + ".ts", stem + ".tsx"]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 一个文件的值级出边（目标绝对路径）。
 *
 * import/export 语句可能跨多行（dsh-any-connect/src 里有 13 处）：按行攒到
 * 花括号闭合，取整句再判。行首锚点保证攒出来的总是完整语句——注释行永远
 * 进不了累加器。累加超 30 行还没闭合就丢弃（防病句文件拖死扫描，正常导入
 * 远短于此）。
 */
function valueTargets(text: string, file: string): string[] {
  const targets: string[] = [];
  const pushStatement = (statement: string): void => {
    const side = SIDE_EFFECT_RE.exec(statement);
    if (side !== null) {
      const target = resolveTarget(side[1] as string, file);
      if (target !== undefined && target !== file) targets.push(target);
      return;
    }
    const match = FROM_RE.exec(statement);
    if (match === null) return;
    if (statementKind(match[1] as string) !== "value") return;
    const target = resolveTarget(match[2] as string, file);
    if (target !== undefined && target !== file) targets.push(target);
  };
  let current = "";
  let depth = 0;
  let lines = 0;
  const reset = (): void => {
    current = "";
    depth = 0;
    lines = 0;
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (current === "") {
      if (!trimmed.startsWith("import") && !trimmed.startsWith("export")) continue;
    }
    current += (current === "" ? "" : "\n") + trimmed;
    lines += 1;
    for (const ch of trimmed) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (lines > 30) {
      reset();
      continue;
    }
    if (depth > 0) continue;
    pushStatement(current);
    reset();
  }
  return targets;
}

function srcFiles(): string[] {
  const out: string[] = [];
  const packagesDir = join(ROOT, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const src = join(packagesDir, entry.name, "src");
    if (!existsSync(src)) continue;
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(item.name)) continue;
        const full = join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(item.name)) out.push(full);
      }
    };
    walk(src);
  }
  return out;
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const visit = (node: string, stack: string[]): void => {
    color.set(node, GRAY);
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (color.get(next) === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if ((color.get(next) ?? WHITE) === WHITE) {
        visit(next, [...stack, next]);
      }
    }
    color.set(node, BLACK);
  };
  for (const node of [...graph.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node, [node]);
  }
  return cycles;
}

describe("运行时导入无环", () => {
  it("packages 星号 src 里没有值级导入环", () => {
    const files = srcFiles().filter((file) => file !== SELF);
    const graph = new Map<string, Set<string>>();
    for (const file of files) {
      graph.set(file, new Set(valueTargets(readFileSync(file, "utf8"), file)));
    }
    const cycles = findCycles(graph);
    const shown = cycles.slice(0, 5).map((cycle) =>
      cycle.map((file) => file.replace(ROOT + "/", "")).join(" -> "),
    );
    expect(shown, "发现运行时导入环：把其中一条边改成 import type（若只是类型需要）或重排归属").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const files = srcFiles();
    expect(files.length).toBeGreaterThanOrEqual(80);
    let edges = 0;
    for (const file of files) edges += valueTargets(readFileSync(file, "utf8"), file).length;
    expect(edges, "值级边数量应可观（否则判据空转）").toBeGreaterThanOrEqual(150);
    expect(files).not.toContain(SELF);
  });

  it("判据本身有效：语句分类与环检测", () => {
    expect(statementKind("type { X }")).toBe("type");
    expect(statementKind("{ type X, type Y }")).toBe("type");
    expect(statementKind("{ X, type Y }")).toBe("value");
    expect(statementKind("{ X }")).toBe("value");
    expect(statementKind("* as ns")).toBe("value");
    expect(statementKind("Default")).toBe("value");
    const cyclic = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set(["a"])],
    ]);
    expect(findCycles(cyclic)).toEqual([["a", "b", "c", "a"]]);
    const acyclic = new Map([
      ["a", new Set(["b", "c"])],
      ["b", new Set(["c"])],
      ["c", new Set<string>([])],
    ]);
    expect(findCycles(acyclic)).toEqual([]);
  });
});
