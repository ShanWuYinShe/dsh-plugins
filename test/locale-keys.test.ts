import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 文案表回归：没有「定义了却没人用」的 key，且 en / zh 键集一致。
 *
 * 2026-10-08 审计发现 7 个死键（any-connect 的 claimNone / signedIn，sandbox 的 5 个
 * root*）：它们在 locales 之外零引用，是重构后留下的残骸。死键比死代码更隐蔽——不会报错，
 * 只会让文案表越来越不可信（改口径时没人知道哪些是真在用的）。
 *
 * 判据（避免误伤动态拼接）：
 * 1. 键在**本包 client 源码**里以字符串字面量出现，或某个字面量是它的前缀
 *    （`t('sortBy_' + sortKey)` 这类拼接靠前缀规则覆盖）；
 * 2. 确实只由宿主渲染、包内不出现的键登记在 HOST_RENDERED 里并写明理由；
 * 3. 同一包内 en 与 zh 的键集必须完全一致（漏译会在这里现形）。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/**
 * 宿主直接渲染、包内不出现字面量的 key：键 → 理由。
 * 目前为空——包自己渲染的文案都该在包内出现。
 */
const HOST_RENDERED: Readonly<Record<string, string>> = {};

function clientFiles(pkgDir: string, out: string[] = []): string[] {
  const clientDir = join(pkgDir, "client");
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && name !== "locales.ts") out.push(path);
    }
  };
  if (statSync(clientDir).isDirectory()) walk(clientDir);
  return out;
}

function keysFromDictionary(text: string, name: string): string[] | undefined {
  const match = new RegExp(`export const ${name}(?::[^=]+)? = \\{([\\s\\S]*?)\\n\\}`).exec(text);
  if (match === null) return undefined;
  const body = match[1] ?? "";
  return [...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1] as string);
}

function keysFromTypeUnion(text: string): string[] | undefined {
  const match = /export type \w*LocaleKey =([\s\S]*?)\n\n/.exec(text);
  if (match === null) return undefined;
  const body = match[1] ?? "";
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

function packagesWithLocales(): { name: string; dir: string; locales: string }[] {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir)
    .map((name) => ({ name, dir: join(packagesDir, name) }))
    .filter(({ dir }) => statSync(dir).isDirectory())
    .flatMap(({ name, dir }) => {
      const locales = join(dir, "client", "locales.ts");
      try {
        statSync(locales);
      } catch {
        return [];
      }
      return [{ name, dir, locales }];
    });
}

describe("文案表", () => {
  it("每个 key 都要在本包 client 源码里出现（或登记为宿主渲染）", () => {
    const offenders: string[] = [];
    for (const pkg of packagesWithLocales()) {
      const text = readFileSync(pkg.locales, "utf8");
      const keys = keysFromDictionary(text, "en") ?? keysFromTypeUnion(text) ?? [];
      const source = clientFiles(pkg.dir).map((file) => readFileSync(file, "utf8")).join("\n");
      const literals = new Set<string>([...source.matchAll(/['"]([\w.$-]+)['"]/g)].map((m) => m[1] as string));
      for (const key of keys) {
        if (HOST_RENDERED[key] !== undefined) continue;
        if (literals.has(key)) continue;
        if ([...literals].some((literal: string) => literal.length >= 3 && key.startsWith(literal) && key.length > literal.length)) continue;
        offenders.push(`${pkg.name} :: ${key}`);
      }
    }
    expect(offenders, "这些文案 key 没有任何引用：删掉它，或登记到 HOST_RENDERED 并写明理由").toEqual([]);
  });

  it("en 与 zh 的键集一致", () => {
    const offenders: string[] = [];
    for (const pkg of packagesWithLocales()) {
      const text = readFileSync(pkg.locales, "utf8");
      const en = keysFromDictionary(text, "en");
      const zh = keysFromDictionary(text, "zh");
      if (en === undefined || zh === undefined) continue;
      const onlyEn = en.filter((key) => !zh.includes(key));
      const onlyZh = zh.filter((key) => !en.includes(key));
      if (onlyEn.length > 0 || onlyZh.length > 0) offenders.push(`${pkg.name} :: 仅 en ${onlyEn.join(",")} / 仅 zh ${onlyZh.join(",")}`);
    }
    expect(offenders, "en 与 zh 的键集必须一致（漏译或删一半）").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const packages = packagesWithLocales();
    expect(packages.length).toBeGreaterThanOrEqual(3);
    const total = packages.reduce((sum, pkg) => {
      const text = readFileSync(pkg.locales, "utf8");
      return sum + (keysFromDictionary(text, "en") ?? keysFromTypeUnion(text) ?? []).length;
    }, 0);
    expect(total).toBeGreaterThanOrEqual(60);
    expect(HOST_RENDERED["__self_check__"]).toBeUndefined();
    expect(readFileSync(SELF, "utf8")).toContain("HOST_RENDERED");
  });
});
