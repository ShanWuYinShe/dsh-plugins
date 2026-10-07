import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 声明依赖回归：devDependencies 里不留「声明了却从不导入」的包。
 *
 * 2026-10-08 审计发现 7 个这样的声明（dsh-any-connect 4 个、provider-usage 2 个、
 * session-archive 1 个）：它们既没有出现在任何 import 里，也不对应 inject 的服务名
 * （对照 README「内部包作为 devDependencies 安装」的约定），是历史遗留。删除后
 * bun install 少装 7 个包，typecheck 与全量测试仍绿——**「没坏」不等于「有用」**，
 * 这类声明只会让依赖清单越来越不可信。
 *
 * 判据：每个包的每个 devDependency 都要在**本包源码**里以模块说明符出现
 * （静态 import、`import()`、`require()` 都算，子路径如 `pkg/sub` 也算）。
 * 确实需要「声明但不导入」的包（例如只提供类型增强或 CLI 二进制）登记在
 * ALLOWED_UNREFERENCED 里并写明理由。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);
const SOURCE_RE = /\.(?:ts|tsx|mjs|cjs)$/;

/**
 * 允许「声明但不导入」的包：包名 → 理由。
 * 目前为空——按判据，每个声明都该有引用。
 */
const ALLOWED_UNREFERENCED: Readonly<Record<string, string>> = {};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SOURCE_RE.test(name)) out.push(path);
  }
  return out;
}

/** 本包源码里是否出现过这个模块说明符（含子路径）。 */
function isReferenced(text: string, name: string): boolean {
  return text.includes(`'${name}'`) || text.includes(`"${name}"`) || text.includes(`'${name}/`) || text.includes(`"${name}/`);
}

function packagesWithDevDeps(): { name: string; dir: string; devDeps: string[] }[] {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir)
    .map((name) => ({ name, dir: join(packagesDir, name) }))
    .filter(({ dir }) => statSync(dir).isDirectory())
    .map(({ name, dir }) => {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { devDependencies?: Record<string, string> };
      return { name, dir, devDeps: Object.keys(manifest.devDependencies ?? {}) };
    })
    .filter((pkg) => pkg.devDeps.length > 0);
}

describe("声明依赖", () => {
  it("devDependencies 里的每个包都要在包内源码中出现", () => {
    const offenders: string[] = [];
    for (const pkg of packagesWithDevDeps()) {
      const text = sourceFiles(pkg.dir).map((file) => readFileSync(file, "utf8")).join("\n");
      for (const dep of pkg.devDeps) {
        if (ALLOWED_UNREFERENCED[dep] !== undefined) continue;
        if (!isReferenced(text, dep)) offenders.push(`${pkg.name} :: ${dep}`);
      }
    }
    expect(offenders, "这些 devDependency 没有任何引用：删掉它，或登记到 ALLOWED_UNREFERENCED 并写明理由").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const packages = packagesWithDevDeps();
    expect(packages.length).toBeGreaterThanOrEqual(3);
    const total = packages.reduce((sum, pkg) => sum + pkg.devDeps.length, 0);
    expect(total).toBeGreaterThanOrEqual(15);
    expect(ALLOWED_UNREFERENCED["__self_check__"]).toBeUndefined();
    expect(readFileSync(SELF, "utf8")).toContain("ALLOWED_UNREFERENCED");
  });
});
