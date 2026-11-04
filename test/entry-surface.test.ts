import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 入口面锁：插件入口只导出 Loader 认得的元数据，不把内部实现变成包 API。
 *
 * 判据来源（DSH 官方 docs/defensive-patterns/package-surface.md
 * 「A plugin package exports what the Loader loads」与 packages/client/AGENTS.md）：
 *
 * - **Host 入口**（`src/index.ts`）：function plugin 只导出
 *   `name` / `inject` / `Config` / `apply`。Cordis 的 `Plugin.Base` 还认
 *   `provide` / `intercept`，本仓不使用。测试要用的内部实现从
 *   `../src/<module>.js` 相对导入——测试便利值一旦从入口转发，就会冻结成
 *   永久公开 API（历史上 dsh-any-connect 入口累计转发 150 个名字）。
 * - **Client 入口**（`client/index.tsx`）：只导出 `name` / `inject` / `apply`；
 *   实现值不得成为入口导出。
 *
 * 额外禁止 `export default` 与 `export *`：前者会让 Loader 的
 * `unwrapExports`（`exports.default ?? exports`）换掉整个插件命名空间，后者
 * 把未审计的实现一次性暴露出去。类型导出（`export type` / `{ type X }`）不产生
 * 运行时值，允许存在。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Host 入口允许的运行时导出（Cordis Plugin.Base + function plugin 形态）。 */
const HOST_ALLOWED = new Set(["name", "inject", "Config", "apply"]);
/** Host 入口必须存在的导出。 */
const HOST_REQUIRED = ["name", "inject", "apply"];
/** Client 入口允许的运行时导出。 */
const CLIENT_ALLOWED = new Set(["name", "inject", "apply"]);
/** Client 入口必须存在的导出（name 可选）。 */
const CLIENT_REQUIRED = ["inject", "apply"];

interface ParsedExports {
  /** 运行时值导出名。 */
  values: Set<string>;
  /** 结构性违规（default / export *）。 */
  violations: string[];
}

/** 去掉注释，避免注释里的示例文本被当作导出语句。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 解析一个入口文件的运行时值导出。
 *
 * 支持四种形态（本仓入口只用这些）：`export const|let|function|class NAME`、
 * 单行/多行 `export { a, b as c, type T } [from '…']`、`export type {…}`（忽略）、
 * `export default` / `export *`（记为违规）。
 */
function parseExports(source: string): ParsedExports {
  const text = stripComments(source);
  const values = new Set<string>();
  const violations: string[] = [];
  if (/^\s*export\s+default\b/m.test(text)) violations.push("export default");
  if (/^\s*export\s*\*/m.test(text)) violations.push("export *");
  for (const match of text.matchAll(/^\s*export\s+(?:declare\s+)?(?:async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    values.add(match[1]!);
  }
  for (const match of text.matchAll(/(^|\n)\s*export\s+(type\s*)?\{([\s\S]*?)\}\s*(?:from\s*['"][^'"]+['"])?/g)) {
    // `export type { … }` 是纯类型面：不产生运行时值。
    if (match[2] !== undefined) continue;
    for (const raw of match[3]!.split(",")) {
      let item = raw.trim();
      if (item === "") continue;
      if (/^type\s/.test(item)) continue;
      item = item.replace(/^type\s+/, "");
      const alias = item.split(/\s+as\s+/);
      const name = (alias.length > 1 ? alias[1]! : alias[0]!).trim();
      if (name !== "") values.add(name);
    }
  }
  return { values, violations };
}

function packages(): string[] {
  return readdirSync(join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => statSync(join(ROOT, "packages", name, "package.json"), { throwIfNoEntry: false })?.isFile() === true)
    .sort();
}

function entryExports(relPath: string): ParsedExports {
  return parseExports(readFileSync(join(ROOT, relPath), "utf8"));
}

function checkSurface(label: string, parsed: ParsedExports, allowed: Set<string>, required: string[]): void {
  expect(parsed.violations, `${label}: 禁止 default / export *`).toEqual([]);
  for (const name of required) {
    expect(parsed.values.has(name), `${label}: 缺少 Loader 必需导出 ${name}`).toBe(true);
  }
  const extras = [...parsed.values].filter((name) => !allowed.has(name)).sort();
  expect(extras, `${label}: 入口多导出 ${extras.join(", ")}——测试从 ../src/<module>.js 相对导入，不要冻结成包 API`).toEqual([]);
}

const PKGS = packages();

describe("入口面：插件只导出 Loader 元数据", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(PKGS.length).toBeGreaterThanOrEqual(4);
  });

  for (const pkg of PKGS) {
    it(`${pkg} host 入口只导出 name/inject/Config/apply`, () => {
      checkSurface(`${pkg}/src/index.ts`, entryExports(`packages/${pkg}/src/index.ts`), HOST_ALLOWED, HOST_REQUIRED);
    });

    it(`${pkg} client 入口只导出 name/inject/apply`, () => {
      const path = join(ROOT, "packages", pkg, "client", "index.tsx");
      // 有 client 面的包才有入口；纯 host 包跳过。
      const hasClient = statSync(path, { throwIfNoEntry: false })?.isFile() === true;
      if (!hasClient) return;
      checkSurface(`${pkg}/client/index.tsx`, entryExports(`packages/${pkg}/client/index.tsx`), CLIENT_ALLOWED, CLIENT_REQUIRED);
    });
  }
});

describe("入口面判据自身有效", () => {
  // 注意：这里的说明符必须**拼出来**，不要在源码里写真实的相对导入字面量——本仓
  // 另有 import-paths（相对导入必须解析到真实文件）与 export-surface（转发导出必须
  // 有导入者）两把锁会扫到本文件的源码文本，字面 fixture 会把它们误判成真实代码。
  const spec = "./fixture-entry.js";

  it("能识别 const/function 与花括号导出、忽略类型导出", () => {
    const parsed = parseExports([
      "export const name = 'x'",
      "export const inject: string[] = []",
      "export function apply() {}",
      `export type { Options } from '${spec}'`,
      `export { a, b as c, type T } from '${spec}'`,
    ].join("\n"));
    expect([...parsed.values].sort()).toEqual(["a", "apply", "c", "inject", "name"]);
    expect(parsed.violations).toEqual([]);
  });

  it("能识别 default 与 export * 违规", () => {
    expect(parseExports("export default class X {}").violations).toContain("export default");
    expect(parseExports(`export * from '${spec}'`).violations).toContain("export *");
  });
});
