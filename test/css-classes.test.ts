import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 样式表回归：没有「写了样式却没人挂这个类」的死规则。
 *
 * 2026-10-08 审计发现 5 条死规则：session-archive 的 sa_msgText / sa_msgTextUser（被
 * sa_msgBubble 那套设计取代）、sandbox 的 ser_warn / ser_info / ser_danger（状态改用
 * ser_status + ser_status--ok）。死样式比死代码更隐蔽：删了不报错、留着也没人看得见，
 * 只会让样式表越读越像「可能有用」。
 *
 * 判据：样式表里出现的每个类名，都要在本包 client 的其它源码里以子串出现
 * （class 名足够独特，子串匹配不会误伤；动态拼接出来的类名登记在 DYNAMIC 里并写明理由）。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/**
 * 允许「样式里有、源码里拼不出来」的类名：类名 → 理由。
 * 目前为空——每个类都该在源码里直接出现。
 */
const DYNAMIC: Readonly<Record<string, string>> = {};

const QUOTES = "'\"\u0060";
const LITERAL = new RegExp("[" + QUOTES + "]([^" + QUOTES + "]*)" + "[" + QUOTES + "]", "g");

function styleFiles(clientDir: string): string[] {
  return readdirSync(clientDir).filter((name) => name.includes("styles") && name.endsWith(".ts"));
}

function classNamesIn(text: string): string[] {
  const css = [...text.matchAll(LITERAL)].map((m) => m[1] ?? "").join("\n");
  return [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string))].filter((name) => name !== "css");
}

function packagesWithStyles(): { name: string; clientDir: string; styles: string[] }[] {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir)
    .map((name) => ({ name, clientDir: join(packagesDir, name, "client") }))
    .filter(({ clientDir }) => {
      try {
        return statSync(clientDir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(({ name, clientDir }) => {
      const styles = styleFiles(clientDir);
      return styles.length > 0 ? [{ name, clientDir, styles }] : [];
    });
}

describe("样式表", () => {
  it("每个 CSS 类都要在本包 client 源码里出现", () => {
    const offenders: string[] = [];
    for (const pkg of packagesWithStyles()) {
      const classes = pkg.styles.flatMap((name) => classNamesIn(readFileSync(join(pkg.clientDir, name), "utf8")));
      const source = readdirSync(pkg.clientDir)
        .filter((name) => /^[\w.-]+\.tsx?$/.test(name) && !pkg.styles.includes(name) && name !== "locales.ts")
        .map((name) => readFileSync(join(pkg.clientDir, name), "utf8"))
        .join("\n");
      for (const className of classes) {
        if (DYNAMIC[className] !== undefined) continue;
        if (!source.includes(className)) offenders.push(`${pkg.name} :: ${className}`);
      }
    }
    expect(offenders, "这些 CSS 类没有任何引用：删掉这条规则，或登记到 DYNAMIC 并写明理由").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const packages = packagesWithStyles();
    expect(packages.length).toBeGreaterThanOrEqual(3);
    const total = packages.reduce((sum, pkg) => sum + pkg.styles.flatMap((name) => classNamesIn(readFileSync(join(pkg.clientDir, name), "utf8"))).length, 0);
    expect(total).toBeGreaterThanOrEqual(50);
    expect(DYNAMIC["__self_check__"]).toBeUndefined();
    expect(readFileSync(SELF, "utf8")).toContain("DYNAMIC");
  });
});
