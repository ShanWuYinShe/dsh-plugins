import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 已废弃 API 使用锁：DSH 0.2.2-rc.1 实装里带 @deprecated 的调用面一律禁止新增。
 *
 * 依据：rc.1 实装 `.d.ts` 全量 grep 只命中 4 条——
 * - `@deepseek-ai/dsh-session`：`Session.eventAt()` / `snapshotEvents()` /
 *   `ownEvents()`（"new calls are prohibited"）；
 * - `@deepseek-ai/dsh-api-session-controller`：`SessionController.page()`
 *   （"Use `events`"）。
 *
 * 当前四包源码零引用（2026-11-04 审计核实），但没有任何东西拦得住以后误引入：
 * 废弃面会在下一个宿主版本被删，届时插件运行时才炸。因此把 4 个调用形态写死。
 *
 * 反向验证方式：在任一包 src 里临时写 `session.eventAt(0)`，本锁必须报红。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

interface Forbidden {
  /** 文档里展示的废弃面名字。 */
  readonly name: string;
  /** 调用形态匹配（带左括号，避免命中类型声明/注释中的裸名字）。 */
  readonly pattern: RegExp;
}

/** rc.1 实装 @deprecated 的调用形态。新增条目必须同时更新 checklist B.1 的统计口径。 */
const FORBIDDEN: readonly Forbidden[] = [
  { name: "Session.eventAt()", pattern: /\beventAt\s*\(/ },
  { name: "Session.snapshotEvents()", pattern: /\bsnapshotEvents\s*\(/ },
  { name: "Session.ownEvents()", pattern: /\bownEvents\s*\(/ },
  { name: "SessionController.page()", pattern: /\.page\s*\(/ },
];

/** 递归收集目录下的 .ts/.tsx（跳过 node_modules）。 */
function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sources(path));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

const PACKAGES = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(ROOT, "packages", entry.name))
  .filter((path) => statSync(join(path, "package.json"), { throwIfNoEntry: false })?.isFile() === true)
  .sort();

const SCANNED = PACKAGES.flatMap((pkg) => [...sources(join(pkg, "src")), ...sources(join(pkg, "client"))]);

describe("已废弃 API 使用锁（0.2.2-rc.1 @deprecated 面）", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(PACKAGES.length).toBeGreaterThanOrEqual(4);
    expect(SCANNED.length, "应扫到足够多的源文件").toBeGreaterThan(50);
  });

  it("判据本身有效：4 个废弃调用形态能被识别", () => {
    const samples = ["session.eventAt(0)", "session.snapshotEvents()", "session.ownEvents()", "sessionController.page(req, signal)"];
    for (const [index, sample] of samples.entries()) {
      expect(FORBIDDEN[index]!.pattern.test(sample), `判据漏掉 ${FORBIDDEN[index]!.name}`).toBe(true);
    }
  });

  for (const pkg of PACKAGES) {
    const name = pkg.split("/").pop()!;
    it(`${name}: 不使用 0.2.2-rc.1 已废弃的宿主 API`, () => {
      const violations: string[] = [];
      for (const file of SCANNED.filter((path) => path.startsWith(pkg + "/"))) {
        const text = readFileSync(file, "utf8");
        for (const forbidden of FORBIDDEN) {
          if (forbidden.pattern.test(text)) {
            violations.push(`${file.slice(ROOT.length + 1)}: ${forbidden.name}`);
          }
        }
      }
      expect(violations, `以下位置使用了已废弃 API，改用官方替代面（events() 等）`).toEqual([]);
    });
  }
});
