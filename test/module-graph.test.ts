import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 模块图回归：没有「孤儿模块」。
 *
 * 拆模块时最容易犯的错是把一段**靠导入副作用生效**的代码搬进新文件却忘了导入它——
 * 编译、类型检查、绝大多数测试都不会发现，只有运行时才暴露。2026-10-08 就发生过一次：
 * sandbox-extra-roots 的样式注入被搬进 client/styles.ts，但没人导入它，产物里既没有
 * 样式表也没有注入代码，设置卡片变成无样式（本轮靠「无导入者的模块」审计抓到）。
 *
 * 判据：
 * 1. 各包的 src 与 client 目录下每个模块都要被别的模块引用（静态 import、
 *    动态 import() 或 require() 都算），入口与按包导出面暴露的模块除外；
 * 2. client 的 styles 模块（副作用注入样式）必须被同包 client 的其它文件导入。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);
const SOURCE_RE = /\.tsx?$/;

/**
 * 允许没有相对导入者的模块：
 * - index.ts / index.tsx：包入口；
 * - typert.host.ts：通过 package.json exports 的 "./typert" 暴露给宿主加载器；
 * - bin.ts：package.json 的 bin 入口（CLI）；
 * - *.d.ts：只有类型声明，运行时不存在。
 */
const ENTRY_MODULES = new Set(["index.ts", "index.tsx", "typert.host.ts", "bin.ts"]);

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

/** 解析相对 specifier（TS 写 .js，实际 .ts/.tsx/.d.ts；也接受目录 index）。 */
function resolveSpecifier(specifier: string, fromFile: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  if (specifier.endsWith(".js")) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}.js`);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`);
  }
  candidates.push(join(base, "index.ts"), join(base, "index.tsx"));
  return candidates.find((candidate) => existsSync(candidate));
}

/** 一个文件引用的所有相对模块（静态、动态、require 三种写法都算）。 */
function referencedModules(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers = [
    ...[...text.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => match[1]!),
    // 无 from 的副作用导入（import './styles.js'）——本轮修的就是这种写法，别漏。
    ...[...text.matchAll(/import\s+["'](\.[^"']+)["']/g)].map((match) => match[1]!),
    ...[...text.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)].map((match) => match[1]!),
    ...[...text.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)].map((match) => match[1]!),
  ];
  return specifiers.map((specifier) => resolveSpecifier(specifier, file)).filter((target): target is string => target !== undefined);
}

const packageModules = collect(ROOT).filter((file) => /\/packages\/[^/]+\/(src|client)\//.test(file));
const imported = new Set<string>();
const importers = new Map<string, Set<string>>();
for (const file of packageModules) {
  for (const target of referencedModules(file)) {
    imported.add(target);
    const set = importers.get(target) ?? new Set<string>();
    set.add(file);
    importers.set(target, set);
  }
}

describe("模块图", () => {
  it("没有孤儿模块（除了入口与包导出面）", () => {
    const orphans = packageModules
      .filter((file) => !imported.has(file) && !ENTRY_MODULES.has(basename(file)) && !file.endsWith(".d.ts"))
      .map((file) => file.slice(ROOT.length + 1));
    expect(orphans, "这些模块没有任何导入者：若靠导入副作用生效，必须有人导入它").toEqual([]);
  });

  it("client 的 styles 模块必须被同包 client 导入（样式注入是加载副作用）", () => {
    const offenders: string[] = [];
    for (const styles of packageModules.filter((file) => basename(file) === "styles.ts")) {
      const clientDir = dirname(styles);
      const importedBy = [...(importers.get(styles) ?? [])].filter((file) => dirname(file) === clientDir);
      if (importedBy.length === 0) offenders.push(styles.slice(ROOT.length + 1));
    }
    expect(offenders, "styles.ts 无人导入：样式注入副作用不会执行").toEqual([]);
  });

  it("判据本身有效（模块与引用边数量合理）", () => {
    expect(packageModules.length).toBeGreaterThan(60);
    expect(imported.size).toBeGreaterThan(40);
  });
});
