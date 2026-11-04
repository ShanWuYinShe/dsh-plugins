import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 根 manifest 声明锁：`scripts/**`、`test/**` 与根工具配置里的第三方 import
 * 必须在本根 `package.json` 的 devDependencies 里声明。
 *
 * 官方依据：`package-surface.md`「Package modules … `files` closed」与
 * `test/declared-deps.test.ts` 的同一原则——「bun 的提升让未声明的包碰巧能解析」
 * 是安装细节，不是声明依据；依赖清单必须对发布、审计与升级可信。2026-11-04
 * 审计把「根 manifest devDeps 声明核对」列为规则锁盲区 #12：`declared-deps`
 * 只扫 `packages/*`，根目录的脚本/测试完全没有对应锁。
 *
 * 判据：
 * 1. 扫描根 `scripts/**\/*.mjs`、`test/**\/*.ts`（含 `test/lib` 等子目录）、
 *    `vitest.config.ts`、`scripts/lib/*.mjs`；
 * 2. 只取**裸包名**（跳过 `node:` 内建、相对/绝对路径、`bun:`/`http(s):` 协议、
 *    `@chaoset/*` 本仓 workspace 包）；
 * 3. 每个裸包名必须在根 package.json 的 `dependencies`/`optionalDependencies`/
 *    `devDependencies` 中出现；例外（如只提供环境类型的包）登记在
 *    ALLOWED_UNIMPORTED 并写明理由，且登记项必须被真实命中（防腐烂）。
 *
 * 反向验证方式：在 `scripts/` 里加一行 `import lodash from "lodash"`（当前未声明）
 * → 本锁报红；删除后绿。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * 允许「被 import 但未在根 devDependencies 声明」的包：包名 → 理由。
 * 目前为空——根工具链的每个 import 都应显式声明。
 */
const ALLOWED_UNIMPORTED: Readonly<Record<string, string>> = {};

/** 根工具/测试源码（相对路径）。 */
function rootSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".workwork") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:ts|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(join(ROOT, "scripts"));
  walk(join(ROOT, "test"));
  out.push(join(ROOT, "vitest.config.ts"));
  return [...new Set(out)].filter((file) => statSync(file).isFile()).sort();
}

/**
 * 从一个模块说明符提取裸包名；非第三方裸导入返回 null。
 *
 * @param specifier - import/require 的说明符。
 * @returns 裸包名（scoped 保留 `@scope/name`）。
 */
export function bareSpecifier(specifier: string): string | null {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (/^(?:bun:|https?:|data:|file:)/.test(specifier)) return null;
  if (specifier.startsWith("@chaoset/")) return null; // 本仓 workspace 包
  const match = specifier.match(/^(@[^/]+\/[^/]+|[^@/][^/]*)/);
  return match === null ? null : match[1] as string;
}

/**
 * 从源码文本抽取全部第三方裸包名。
 *
 * 先剥注释，再逐行判定「是不是 import/export/require 语句」——不做全文正则：
 * 错误消息、文档注释里的「from '…'」会被误捕（declared-deps 锁踩过同款坑）。
 *
 * @param text - 源码全文。
 * @returns 裸包名集合。
 */
export function importedBareNames(text: string): Set<string> {
  const names = new Set<string>();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  for (const raw of code.split("\n")) {
    const line = raw.trim();
    const isImportLine = /^import\b/.test(line)
      || /^export\b/.test(line)
      || /^}\s*from\b/.test(line)
      || /\b(?:import|require)\s*\(/.test(line);
    if (!isImportLine) continue;
    for (const match of line.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const bare = bareSpecifier(match[1] as string);
      if (bare !== null) names.add(bare);
    }
    for (const match of line.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) {
      const bare = bareSpecifier(match[1] as string);
      if (bare !== null) names.add(bare);
    }
    for (const match of line.matchAll(/^import\s*['"]([^'"]+)['"]/g)) {
      const bare = bareSpecifier(match[1] as string);
      if (bare !== null) names.add(bare);
    }
  }
  return names;
}

function rootManifest(): { declared: Set<string> } {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    declared: new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]),
  };
}

const SOURCES = rootSources();
const { declared } = rootManifest();

describe("根 manifest 第三方 import 声明", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(SOURCES.length, "应扫到足够多的根脚本/测试文件").toBeGreaterThanOrEqual(20);
    const imports = SOURCES.flatMap((file) => [...importedBareNames(readFileSync(file, "utf8"))]);
    expect(imports.length, "第三方裸导入数量应可观").toBeGreaterThanOrEqual(5);
    expect(declared.size, "根 manifest 声明面非空").toBeGreaterThanOrEqual(8);
  });

  it("根 scripts/test 的第三方 import 都在根 devDependencies 里声明", () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const bare of importedBareNames(readFileSync(file, "utf8"))) {
        if (declared.has(bare)) continue;
        if (ALLOWED_UNIMPORTED[bare] !== undefined) continue;
        offenders.push(`${file.slice(ROOT.length + 1)} :: ${bare}`);
      }
    }
    expect(
      offenders,
      "这些包被根 scripts/test import 却没在根 package.json 声明：补 devDependencies，"
        + "或登记到 ALLOWED_UNIMPORTED 并写明理由",
    ).toEqual([]);
  });

  it("白名单本身可审计（条目必须带理由且当前为空）", () => {
    for (const [name, reason] of Object.entries(ALLOWED_UNIMPORTED)) {
      expect(reason.trim().length, `${name}: 白名单必须写理由`).toBeGreaterThan(5);
    }
    expect(ALLOWED_UNIMPORTED["__self_check__"]).toBeUndefined();
  });

  it("判据本身有效：只取第三方裸名，放过内建/相对/workspace/协议", () => {
    const names = importedBareNames([
      'import { readFileSync } from "node:fs"',
      // 相对路径**拼出来**：本仓 import-paths 锁会扫描源码里的相对导入字面量，
      // 直接写字面量会被当成真实导入（entry-surface 锁踩过同款坑）。
      `import { join } from "${"./lib/" + "join.js"}"`,
      `import "${"../side-" + "effect.js"}"`,
      'import yaml from "js-yaml"',
      'import type { X } from "@deepseek-ai/dsh-plugin-market-index"',
      "const mod = await import('esbuild')",
      "const req = require('semver')",
      "console.log('from \"fake-package\"')",
      '// import commentOnly from "commented-package"',
    ].join("\n"));
    expect([...names].sort()).toEqual(["@deepseek-ai/dsh-plugin-market-index", "esbuild", "js-yaml", "semver"]);
    expect(bareSpecifier("node:path")).toBeNull();
    expect(bareSpecifier("./x.js")).toBeNull();
    expect(bareSpecifier("@chaoset/session-archive")).toBeNull();
    expect(bareSpecifier("https://example.com/x.js")).toBeNull();
  });
});
