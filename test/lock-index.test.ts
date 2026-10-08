import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 锁索引完整性回归：test/README.md 的“锁一览”与实际文件双向一致。
 *
 * 2026-10-08 建立：索引表已手工同步 5 次还没漏，但“新增模块后登记”这一步
 * 历史上漏过两次（都是 module-map 锁抓到的）——手工维护的登记项就该上锁。
 * 两个方向都要守：新增锁没登记（读者找不到），删了锁没删行（索引指向空气）。
 *
 * 非锁的单测文件（断言具体模块行为，不扫全仓找退化）不进索引表，而是在
 * UNIT_TESTS 里显式登记——新加单测文件时顺手加一行，逼自己确认“它确实
 * 不是锁”（锁的标准见 test/README.md 的写锁约定第一条）。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 索引表不收录的单测文件：文件名 → 它为什么不是锁。 */
const UNIT_TESTS: Readonly<Record<string, string>> = {
  "dep-collect.test.ts": "依赖收集纯逻辑的单测，不扫全仓",
  "dsh-deps.test.ts": "dsh 基线提取纯逻辑的单测，不扫全仓",
  "publish-gate.test.ts": "发布门禁命令行契约的集成测试，不扫全仓",
  "scripts-cli.test.ts": "其余脚本命令行契约的集成测试，不扫全仓",
  "version-checks.test.ts": "semver/CHANGELOG 纯逻辑的单测，不扫全仓",
};

/** test/README.md “锁一览”段里的文件名集合。 */
function indexRows(): string[] {
  const text = readFileSync(join(ROOT, "test", "README.md"), "utf8");
  const section = text.split("## 锁一览")[1]?.split("\n## ")[0] ?? "";
  const rows: string[] = [];
  for (const match of section.matchAll(/^\| `([^`]+)` \|/gm)) {
    rows.push(match[1] as string);
  }
  return rows;
}

function testFiles(): string[] {
  return readdirSync(join(ROOT, "test"))
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

describe("锁索引完整性", () => {
  it("锁文件与索引表双向一致（单测在 UNIT_TESTS 登记）", () => {
    const rows = new Set(indexRows());
    const unlisted: string[] = [];
    for (const file of testFiles()) {
      if (rows.has(file)) continue;
      if (UNIT_TESTS[file] !== undefined) continue;
      unlisted.push(file);
    }
    const dangling = [...rows].filter((row) => !testFiles().includes(row));
    expect(unlisted, "这些测试文件没进索引：是锁就加表行，是单测就在 UNIT_TESTS 登记").toEqual([]);
    expect(dangling, "这些索引行指向不存在的文件：删行").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    // 下界取当前精确计数：删锁/删文件会掉到下界之下而红灯（删东西必须改这里承认）；
    // 新增只会让计数变大，不受影响——正常加锁/加单测不用碰这里。
    expect(indexRows().length).toBeGreaterThanOrEqual(21);
    expect(testFiles().length).toBeGreaterThanOrEqual(26);
    expect(Object.keys(UNIT_TESTS)).toEqual([...Object.keys(UNIT_TESTS)].sort());
  });

  it("判据本身有效：UNIT_TESTS 只收录真实存在的单测文件", () => {
    const files = new Set(testFiles());
    for (const name of Object.keys(UNIT_TESTS)) {
      expect(files.has(name), `${name} 不存在了：从 UNIT_TESTS 删除`).toBe(true);
      expect(indexRows().includes(name), `${name} 已进索引表：从 UNIT_TESTS 删除`).toBe(false);
    }
  });
});
