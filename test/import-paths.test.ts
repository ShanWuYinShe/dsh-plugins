import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 相对导入的路径与大小写回归。
 *
 * 本仓在 macOS 上开发（文件系统大小写不敏感），但插件在 Linux 上同样要跑：
 * \`import { X } from './ModelRow.js'\` 指向 \`modelRow.tsx\` 这类错误在本机绿、
 * 到 Linux 才炸。脚本化拆分/改名后尤其容易留下这种路径（本轮审计 459 处相对导入，
 * 当前 0 违规——这条锁是防止以后重新引入）。
 *
 * 两条判据：
 * 1. 每个相对导入都能解析到真实文件（\`.js\` 按 TS 约定映射到 .ts/.tsx，含目录 index）；
 * 2. 解析出的文件名与所在目录里的条目**逐字相同**（大小写精确）。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);
const SOURCE_RE = /\.tsx?$/;

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

/** 解析相对导入（TS 源码写 .js，实际是 .ts/.tsx；也接受目录 index）。 */
function resolveImport(spec: string, fromFile: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base];
  if (spec.endsWith(".js")) {
    const stem = base.slice(0, -3);
    // \`.d.ts\`：本仓用 \`./dsh.js\` 引用只有 dsh.d.ts 的宿主类型声明（如 archive-host 系）。
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}.js`);
  } else {
    candidates.push(`${base}.ts`, `${base}.tsx`);
  }
  candidates.push(join(base, "index.ts"), join(base, "index.tsx"));
  return candidates.find((candidate) => existsSync(candidate));
}

/** 目标文件名必须与其所在目录中的条目逐字相同（macOS 上大小写错也 existsSync）。 */
function caseExact(file: string): boolean {
  return readdirSync(dirname(file)).includes(basename(file));
}

/** 本文件的文档注释里举例写了相对导入，不该被自己的规则扫到。 */
const SELF = fileURLToPath(import.meta.url);
const files = collect(ROOT).filter((file) => file !== SELF);

/** 一次读盘：文件 → 文本（两个用例共用）。 */
const TEXTS = new Map<string, string>(files.map((file) => [file, readFileSync(file, "utf8")]));

function relativeImports(file: string): string[] {
  return [...(TEXTS.get(file) ?? "").matchAll(/from\s+["'](\.[^"']+)["']/g)].map((match) => match[1]!);
}

describe("相对导入的路径与大小写", () => {
  it("每条相对导入都能解析到真实文件", () => {
    const dangling: string[] = [];
    for (const file of files) {
      for (const spec of relativeImports(file)) {
        if (resolveImport(spec, file) === undefined) dangling.push(`${basename(file)} → ${spec}`);
      }
    }
    expect(dangling, "存在解析不到目标的相对导入").toEqual([]);
  });

  it("解析出的文件名大小写精确（Linux 上才暴露的错误）", () => {
    const wrongCase: string[] = [];
    for (const file of files) {
      for (const spec of relativeImports(file)) {
        const target = resolveImport(spec, file);
        if (target === undefined || caseExact(target)) continue;
        const actual = readdirSync(dirname(target)).find((entry) => entry.toLowerCase() === basename(target).toLowerCase());
        wrongCase.push(`${basename(file)} → ${spec}（实际 ${actual ?? basename(target)}）`);
      }
    }
    expect(wrongCase, "导入路径大小写与真实文件名不一致").toEqual([]);
  });

  it("判据本身有效（确实扫到了大量相对导入）", () => {
    const total = files.reduce((sum, file) => sum + relativeImports(file).length, 0);
    expect(total).toBeGreaterThan(300);
  });
});
