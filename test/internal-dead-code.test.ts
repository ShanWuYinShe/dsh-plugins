import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 内部死代码回归：未导出的顶层声明必须在同文件里被用到。
 *
 * 2026-10-08 审计发现 3 处：auth.test.ts 的 credentialWith（被内联凭据取代）、
 * catalog-empty-flag.test.ts 的 CREDENTIAL（一段没人用的断言式转换）、catalog-store.ts 的
 * WORKBUDDY_AI_CATALOG_FILENAME（第 32 轮去掉 export 后彻底没人用——**那次「清理导出」反而
 * 把它变成了内部死代码，说明清理要复查一遍**）。
 *
 * 判据：顶层（行首无缩进）的 function / const / let / class 声明，只要没写 export，就必须在
 * 本文件里出现第二次（类型位置也算）。真需要「声明了不用」的登记 ALLOWED 并写明理由。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/**
 * 允许「未导出且零引用」的声明：`文件::名字` → 理由。
 * 目前为空。
 */
const ALLOWED: Readonly<Record<string, string>> = {};

const DECL = /^(?:async )?function ([A-Za-z_$][\w$]*)|^(?:const|let) ([A-Za-z_$][\w$]*)\s*[:=]|^class ([A-Za-z_$][\w$]*)/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function offendersIn(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s/.test(line) || line.startsWith("export")) continue;
    const match = DECL.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name === undefined) continue;
    const key = `${path}::${name}`;
    if (ALLOWED[key] !== undefined) continue;
    const references = [...text.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
    if (references <= 1) found.push(`${path.replace(`${ROOT}/`, "")} :: ${name}`);
  }
  return found;
}

describe("内部死代码", () => {
  it("未导出的顶层声明都要在同文件里被用到", () => {
    const files = sourceFiles(join(ROOT, "packages"));
    const offenders = files.flatMap(offendersIn);
    expect(offenders, "这些声明没人用：删掉它，或登记到 ALLOWED 并写明理由").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const files = sourceFiles(join(ROOT, "packages"));
    expect(files.length).toBeGreaterThanOrEqual(50);
    const declarations = files.reduce((sum, file) => {
      const text = readFileSync(file, "utf8");
      return sum + text.split("\n").filter((line) => !/^\s/.test(line) && !line.startsWith("export") && DECL.test(line)).length;
    }, 0);
    expect(declarations).toBeGreaterThanOrEqual(50);
    expect(ALLOWED["__self_check__"]).toBeUndefined();
    expect(readFileSync(SELF, "utf8")).toContain("ALLOWED");
  });
});
