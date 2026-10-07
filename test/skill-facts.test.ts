import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 技能文档 ↔ 代码事实回归。
 *
 * .agents/skills/ 下的 SKILL.md 是 agent 会话的知识来源，里面写满了代码事实
 * （环境变量名、常量、变体 id、端点字段值）。代码改名或删除后文档不会自动更新，
 * 而照着过期事实操作的会话会做错事（例：去设置一个早已不存在的环境变量）。
 *
 * 本测试抽出文档里反引号包裹的「全大写标识符」，断言每个都能在**实现**里找到；
 * 确实属于外部系统的（ZCode 客户端环境变量、DSH 宿主错误码、POSIX 变量）登记在
 * EXTERNAL_FACTS 里并写明来源。白名单自身也被检查：一旦某条目真的出现在实现里，
 * 说明它不该再留在白名单——避免白名单慢慢变成万能放行。
 *
 * 语料刻意排除 .agents 与 test 目录：否则文档和本测试自己就能把自己证明成
 * 「存在」，检查会退化成恒真。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 外部事实：不在本仓实现里，但文档必须引用它们。 */
const EXTERNAL_FACTS: Record<string, string> = {
  BIGMODEL_USAGE_QUOTA_URL: "ZCode 桌面客户端自己的环境变量（反编译取证），不在本仓代码里",
  ZCODE_BIGMODEL_USAGE_QUOTA_URL: "同上",
  DISCOVERY_UNSUPPORTED: "DSH 宿主的 provider discovery 错误码，不在本仓代码里",
  TMPDIR: "POSIX 环境变量（沙盒/发布流程里重定向用），不是本仓符号",
};

const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "test", "coverage"]);
// 只收实现文件（不含 .md）：文档里提到某符号不算「实现里存在」，否则代码改名后
// 只要 CHANGELOG 还写着旧名就会静默放过。
const SOURCE_RE = /\.(ts|tsx|mjs|js|json|yml|yaml)$/;

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

/** 实现语料：packages 的 src/client 与 scripts（不含 .md、test 与 .agents）。 */
function implementationCorpus(): string {
  return collect(ROOT)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

/** 技能文档里反引号包裹的全大写标识符。 */
function skillTokens(): string[] {
  const tokens = new Set<string>();
  const skillsDir = join(ROOT, ".agents", "skills");
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, "SKILL.md");
    for (const match of readFileSync(file, "utf8").matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) tokens.add(match[1]!);
  }
  return [...tokens].sort();
}

describe("技能文档引用的代码事实仍然存在", () => {
  const corpus = implementationCorpus();
  const tokens = skillTokens();

  it("抽到的标识符数量合理（防止正则失效后恒真）", () => {
    expect(tokens.length).toBeGreaterThan(5);
  });

  // 词边界匹配：X 改名成 X_RENAMED 不该再算「存在」（子串匹配会漏掉这种漂移）。
  const present = (token: string): boolean => new RegExp(`\\b${token}\\b`).test(corpus);

  it("每个标识符都能在实现里找到，或已登记为外部事实", () => {
    const missing = tokens.filter((token) => !present(token) && !(token in EXTERNAL_FACTS));
    expect(missing, "技能文档引用了实现里不存在的标识符：请改文档或登记 EXTERNAL_FACTS").toEqual([]);
  });

  it("外部事实白名单没有过期条目", () => {
    const stale = Object.keys(EXTERNAL_FACTS).filter((token) => present(token));
    expect(stale, "这些标识符已出现在实现里，应从 EXTERNAL_FACTS 删除").toEqual([]);
  });
});
