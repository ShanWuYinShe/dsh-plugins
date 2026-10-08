import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 无静默测试回归：每个看起来像测试的文件都必须被 vitest 收集到。
 *
 * 2026-10-08 建立：此前出过“19 个用例静默不跑”（verbatimModuleSyntax 把类型导入
 * 变成副作用导入，套件加载异常但总数只少不报错）。那次是加载期静默，这把锁防的是
 * 另一类静默——文件根本不在收集范围内：放错目录（如 scripts 下的 *.test.ts），或
 * 用了 include 不匹配的扩展名（如 *.test.tsx，include 只认 .test.ts）。
 *
 * 判据（与 vitest.config.ts 的 include 同源，见下文“配置锁定”用例）：
 * - test/ 下以 .test.ts 结尾 → 被收集；
 * - packages/<包>/test/ 下以 .test.ts 结尾 → 被收集；
 * - 其余任何 *.test.*（目录不对，或扩展名不对）→ 红灯。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/** 相对路径 → 收集状态。非测试文件返回 collected（不管它）。 */
function collectionStatus(relativePath: string): "collected" | "wrong-scope" {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!/\.test\.[^/]+$/.test(normalized)) return "collected";
  if (/^test\/.+\.test\.ts$/.test(normalized)) return "collected";
  if (/^packages\/[^/]+\/test\/.+\.test\.ts$/.test(normalized)) return "collected";
  return "wrong-scope";
}

function allFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) allFiles(full, out);
    else out.push(full);
  }
  return out;
}

describe("无静默测试", () => {
  it("每个 *.test.* 文件都在 vitest 收集范围内", () => {
    const offenders: string[] = [];
    for (const file of allFiles(ROOT)) {
      const relative = file.replace(ROOT + "/", "");
      if (collectionStatus(relative) !== "collected") offenders.push(relative);
    }
    expect(offenders, "这些文件看起来像测试但 vitest 不会收集：挪到 test/ 或 packages/<包>/test/ 下并以 .test.ts 结尾").toEqual([]);
  });

  it("vitest.config.ts 的 include 与本锁假设一致（配置漂移也要红灯）", () => {
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain("test/**/*.test.ts");
    expect(config).toContain("packages/*/test/**/*.test.ts");
  });

  it("扫描面非空（防止规则空转）", () => {
    const testFiles = allFiles(ROOT).filter((file) => /\.test\.ts$/.test(file));
    expect(testFiles.length).toBeGreaterThanOrEqual(80);
  });

  it("判据本身有效：收集状态分类", () => {
    expect(collectionStatus("test/foo.test.ts")).toBe("collected");
    expect(collectionStatus("packages/a/test/foo.test.ts")).toBe("collected");
    expect(collectionStatus("packages/a/test/nested/foo.test.ts")).toBe("collected");
    expect(collectionStatus("scripts/foo.test.ts")).toBe("wrong-scope");
    expect(collectionStatus("packages/a/src/foo.test.ts")).toBe("wrong-scope");
    expect(collectionStatus("test/foo.test.tsx")).toBe("wrong-scope");
    expect(collectionStatus("packages/a/src/index.ts")).toBe("collected");
  });
});
