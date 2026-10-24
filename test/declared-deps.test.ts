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
 */
const ALLOWED_UNREFERENCED: Readonly<Record<string, string>> = {
  "@types/react": "TSX 的类型包,由 TypeScript 自动加载,源码不显式 import",
  "@types/react-dom": "同上,react-dom 入口的类型",
  jsdom: "vitest 测试环境,由测试文件头部的 @vitest-environment 注释选用,源码不 import",
};

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

function packages(): { name: string; dir: string; devDeps: string[]; declared: string[] }[] {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir)
    .map((name) => ({ name, dir: join(packagesDir, name) }))
    .filter(({ dir }) => statSync(dir).isDirectory())
    .map(({ name, dir }) => {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const devDeps = Object.keys(manifest.devDependencies ?? {});
      const declared = [...new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...devDeps,
      ])];
      return { name, dir, devDeps, declared };
    });
}

function packagesWithDevDeps(): { name: string; dir: string; devDeps: string[] }[] {
  return packages()
    .filter((pkg) => pkg.devDeps.length > 0)
    .map(({ name, dir, devDeps }) => ({ name, dir, devDeps }));
}

/**
 * 允许「源码 import 但未声明」的裸包名 → 理由。目前为空——提升只是安装
 * 细节,不是声明依据。
 */
const ALLOWED_UNIMPORTED: Readonly<Record<string, string>> = {};

/** 从一条 import 说明符提取裸包名(@scope/name 或 name);其余返回 null。 */
function bareSpecifier(specifier: string): string | null {
  if (specifier.startsWith("node:") || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("@chaoset/")) return null; // 包间引用(若将来出现,应走 workspace 依赖声明,单独收紧)
  if (/^(bun:|https?:)/.test(specifier)) return null;
  const match = specifier.match(/^(@[^/]+\/[^/]+|[^@/][^/]*)/);
  return match ? match[1]! : null;
}

/**
 * 源码文本里出现的全部裸包名。行级判定 import 语句(行首 import/export、
 * 多行 import 的 "} from" 尾行、动态 import()/require()),再从行内提取
 * 说明符——不做全文正则:注释剥除后,字符串字面量里的自然语言(错误消息
 * "…from \"route missing\""、SSE 的 [DONE] 哨兵、JWT 的 header.payload.sig)
 * 仍会被 "from '…'" 形态误捕(2026-10-24 实测三个误报)。
 */
function importedBareNames(text: string): Set<string> {
  const names = new Set<string>();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    const isImportLine = /^import\b/.test(line) || /^export\b/.test(line) || /^}\s*from\b/.test(line) || /\b(?:import|require)\s*\(/.test(line);
    if (!isImportLine) continue;
    for (const match of line.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const bare = bareSpecifier(match[1]!);
      if (bare !== null) names.add(bare);
    }
    for (const match of line.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) {
      const bare = bareSpecifier(match[1]!);
      if (bare !== null) names.add(bare);
    }
    for (const match of line.matchAll(/^import\s*['"]([^'"]+)['"].*$/g)) {
      const bare = bareSpecifier(match[1]!);
      if (bare !== null) names.add(bare);
    }
  }
  return names;
}

describe("声明依赖", () => {
  it("包源码 import 的三方包都要在包 manifest 声明", () => {
    // bun 的 node_modules 提升会让未声明的包「碰巧」从根 devDependencies
    // 解析到——那是安装细节,不是声明依据;不放锁的话依赖清单对发布与
    // 审计不可信(2026-10-24 审计:react/schemastery/cordis 四处缺口)。
    const offenders: string[] = [];
    for (const pkg of packages()) {
      const text = sourceFiles(pkg.dir).map((file) => readFileSync(file, "utf8")).join("\n");
      for (const bare of importedBareNames(text)) {
        if (ALLOWED_UNIMPORTED[bare] !== undefined) continue;
        if (!pkg.declared.includes(bare)) offenders.push(`${pkg.name} :: ${bare}`);
      }
    }
    expect(offenders, "这些包被源码 import 却未在本包 manifest 声明:补进 devDependencies(宿主包纪律见 dsh-deps 锁),或登记到 ALLOWED_UNIMPORTED 并写明理由").toEqual([]);
  });

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
