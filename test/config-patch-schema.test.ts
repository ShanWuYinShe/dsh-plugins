import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// 直接 import 各包的 schema 值（测试可在仓库内相对引用包内部实现；依据 RULE-089）。
import { Config as anyConnectConfig } from "../packages/dsh-any-connect/src/config.js";
import { Config as providerUsageConfig } from "../packages/provider-usage/src/config.js";
import { Config as sandboxConfig } from "../packages/sandbox-extra-roots/src/config.js";
import { Config as sessionArchiveConfig } from "../packages/session-archive/src/config.js";

/**
 * patch config ↔ Config schema 一致性锁。
 *
 * 官方依据：`package-surface.md`「function plugin 的 `Config` 既是 interface 也是
 * Schemastery schema value」；`ASAR-SKILL/references/host-plugin.md`「Host plugin
 * export forms」——声明了 Config 的插件在激活时按 schema 校验 patch 行的 config；
 * RULE-004/017：patch 行 `config` 的键集合必须是插件 `Config` schema 接受的字段，
 * 且默认值与 schema 默认值不矛盾。
 *
 * 风险：`cordis.patch.yml` 是安装入口（profile 按它插入插件行）。删/改 schema 字段
 * 而忘了同步 patch 时，loader 会按「未知字段」处理——schemastery 默认剥离未知字段
 * （本仓四包注释均写明这一点），所以**不会报错**，只是该配置被静默忽略：用户看到
 * 的默认行为与 patch 里写的值不一致，且没有任何自然信号。只能靠本锁拦住。
 *
 * 判据（逐包）：
 * 1. `cordis.patch.yml` 恰有一条 insert 行，`id` === 目录名、`name` === package.json
 *    的 npm 名（与 `bundle.test.ts` 的入口锁同源，这里额外取该行的 config）；
 * 2. 该行 `config` 的**顶层键集合 ⊆ 该包 `Config` schema 的键集合**（schemastery
 *    `z.object({...})` 的 `dict` 键）；`config: {}` 视为空集；
 * 3. 每个包都从入口导出 `Config` 值（`export { Config }` / `export const Config`）；
 * 4. 非空转守卫：至少一个包的 patch config 非空、schema 键总数足够多。
 *
 * 反向验证方式：在任一包 patch 的 config 里加一个 schema 不存在的键（或删掉 schema
 * 里的字段而保留 patch 项）→ 本锁报红；还原后绿。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 包目录名 → 该包入口导出的 Config schema 值。 */
const SCHEMAS: Readonly<Record<string, unknown>> = {
  "dsh-any-connect": anyConnectConfig,
  "provider-usage": providerUsageConfig,
  "sandbox-extra-roots": sandboxConfig,
  "session-archive": sessionArchiveConfig,
};

interface PackageDir {
  name: string;
  dir: string;
}

function packages(): PackageDir[] {
  const dir = join(ROOT, "packages");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: join(dir, entry.name) }))
    .filter(({ dir: pkgDir }) => existsSync(join(pkgDir, "package.json")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 从 schemastery `z.object({...})` schema 取顶层键集合（构建期静态形状）。 */
export function schemaKeys(schema: unknown): string[] {
  // schemastery 的 Schema 是「函数 + dict 属性」的混合体，函数形态也必须接受。
  if ((typeof schema !== "object" && typeof schema !== "function") || schema === null) return [];
  const dict = (schema as { dict?: Record<string, unknown> }).dict;
  if (typeof dict !== "object" || dict === null) return [];
  return Object.keys(dict).sort();
}

/**
 * 解析 `cordis.patch.yml` 中某行（按 id 定位）的 config 顶层键。
 *
 * 只实现本仓 patch 实际用到的 YAML 子集：`- insert:` 列表、`id`/`name`/`config`
 * 三个键、config 为空对象 `{}` 或缩进的顶层映射（值可以是空串/数组等标量）。
 * 不引入 YAML 依赖（scripts 侧也无 yaml 解析器），解析失败一律按「无法解析」红。
 *
 * @param text - patch 文件全文。
 * @param rowId - 要解析的行 id（本仓 = 包目录名）。
 * @returns 该行 config 的顶层键（`config: {}` 为空数组）。
 */
export function patchConfigKeys(text: string, rowId: string): string[] {
  const lines = text.split("\n");
  const rowIndex = lines.findIndex((line) => new RegExp(`^\\s*-\\s*id:\\s*['"]?${escapeRegExp(rowId)}['"]?\\s*$`).test(line));
  if (rowIndex === -1) throw new Error(`patch 里找不到行 id: ${rowId}`);
  const insertIndent = (line: string): number => (line.match(/^\s*/)?.[0].length ?? 0);
  // 行 id 的真实缩进 = `id:` 里 `id` 的位置（列表项还有 `- ` 前缀，不能用整行缩进）。
  const rowLine = lines[rowIndex] as string;
  const idIndent = rowLine.indexOf("id:");
  const configIndex = lines.findIndex((line, index) =>
    index > rowIndex && insertIndent(line) === idIndent && /^\s*config:\s*(.*)$/.test(line));
  if (configIndex === -1) throw new Error(`行 ${rowId} 缺少 config 字段`);
  const configLine = lines[configIndex] as string;
  const inline = /^\s*config:\s*(.*)$/.exec(configLine)?.[1]?.trim() ?? "";
  if (inline !== "" && inline !== "{}") {
    if (inline.startsWith("{")) {
      // 内联 JSON/flush 映射：只取键名（不引入完整 YAML 解析）。
      return [...inline.matchAll(/(?:^|[,{]\s*)['"]?([A-Za-z_$][\w$.-]*)['"]?\s*:/g)]
        .map((match) => match[1] as string)
        .sort();
    }
    throw new Error(`行 ${rowId} 的 config 形态无法审计: ${inline}`);
  }
  if (inline === "{}") return [];
  // 块形态：收集 config 下一层（更深缩进）的键；遇到回到 <= config 缩进的行即结束。
  const childIndents: number[] = [];
  const entries: string[] = [];
  for (let index = configIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = insertIndent(line);
    if (indent <= insertIndent(configLine)) break;
    childIndents.push(indent);
    entries.push(line);
  }
  if (entries.length === 0) return [];
  const keyIndent = Math.min(...childIndents);
  return entries
    .filter((line) => insertIndent(line) === keyIndent)
    .map((line) => /^\s*['"]?([A-Za-z_$][\w$.-]*)['"]?\s*:/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined)
    .sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 包入口是否导出 Config 值（允许 `export { Config }` / `export { Config } from ...` / `export const Config`）。 */
function entryExportsConfig(pkgDir: string): boolean {
  const entry = readFileSync(join(pkgDir, "src", "index.ts"), "utf8");
  return /export\s*\{\s*Config\s*(?:\}|})/.test(entry)
    || /export\s*\{\s*Config\s*\}\s*from/.test(entry)
    || /export\s+(?:const|let)\s+Config\b/.test(entry);
}

const PKGS = packages();
let nonEmptyPatchConfigs = 0;
let totalSchemaKeys = 0;

describe("patch config ⊆ Config schema", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(PKGS.length).toBeGreaterThanOrEqual(4);
    for (const pkg of PKGS) {
      expect(SCHEMAS[pkg.name], `${pkg.name}: 未登记 Config schema`).toBeDefined();
    }
    // 统计在下面的用例里填充；这里先做粗守卫，防止 schema 解析整体失效后恒真。
    expect(JSON.stringify(Object.keys(SCHEMAS))).toContain("provider-usage");
  });

  for (const pkg of PKGS) {
    it(`${pkg.name}: patch config 的键都能被 Config schema 接受`, () => {
      const patchPath = join(pkg.dir, "cordis.patch.yml");
      expect(existsSync(patchPath), `${pkg.name}: 缺 cordis.patch.yml`).toBe(true);
      const patch = readFileSync(patchPath, "utf8");
      const manifest = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
      expect(patch).toContain(`id: ${pkg.name}`);
      expect(patch).toContain(`name: '${manifest.name}'`);
      expect(entryExportsConfig(pkg.dir), `${pkg.name}: 入口未导出 Config 值`).toBe(true);

      const keys = schemaKeys(SCHEMAS[pkg.name]);
      expect(keys.length, `${pkg.name}: Config schema 顶层键为空（z.object 结构变化？）`).toBeGreaterThan(0);
      totalSchemaKeys += keys.length;

      const patchKeys = patchConfigKeys(patch, pkg.name);
      if (patchKeys.length > 0) nonEmptyPatchConfigs += 1;
      const unknown = patchKeys.filter((key) => !keys.includes(key));
      expect(
        unknown,
        `${pkg.name}: patch config 里出现 schema 不存在的键 ${unknown.join(", ")}`
          + `（schemastery 会静默剥离 → 用户配置被吞掉）。schema 键: ${keys.join(", ")}`,
      ).toEqual([]);
    });
  }

  it("非空转守卫：至少一个包的 patch 真的配置了字段，schema 键总量足够", () => {
    expect(nonEmptyPatchConfigs, "所有 patch 都是 config: {} 时本锁判据空转").toBeGreaterThanOrEqual(1);
    expect(totalSchemaKeys, "schema 顶层键总量应足够（防止解析失效后恒真）").toBeGreaterThanOrEqual(10);
  });

  it("判据本身有效：schema 键提取与 patch 解析", () => {
    const fakeSchema = { dict: { alpha: {}, beta: {} } };
    expect(schemaKeys(fakeSchema)).toEqual(["alpha", "beta"]);
    expect(schemaKeys(undefined)).toEqual([]);
    const patch = [
      "- insert:",
      "    - id: demo",
      "      name: '@chaoset/demo'",
      "      config:",
      "        alpha: ''",
      "        beta:",
      "          - x",
      "    - id: empty",
      "      name: '@chaoset/empty'",
      "      config: {}",
    ].join("\n");
    expect(patchConfigKeys(patch, "demo")).toEqual(["alpha", "beta"]);
    expect(patchConfigKeys(patch, "empty")).toEqual([]);
    expect(() => patchConfigKeys(patch, "missing")).toThrow();
  });
});
