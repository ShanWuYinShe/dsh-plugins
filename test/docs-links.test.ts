import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 文档链接回归：仓库里每个 Markdown 相对链接都要指向真实存在的文件。
 *
 * 2026-10-08 建立：改文件 / 拆模块之后，文档里的链接会变成死链——它不报错、不影响构建，
 * 只有读者点进去才发现 404。这类「没有自然信号的退化」正是本目录其余锁的共同主题。
 *
 * 判据只覆盖 Markdown 链接（方括号 + 圆括号那类）：正文里反引号标注的路径不做断言——
 * 它们常按 basename 引用模块名，或指向宿主 / 桌面端的文件（如 ZCode 的 setting.json），
 * 或出现在 CHANGELOG 这类历史记录里（记的正是「删掉某文件」）。试过一次，7 处「可疑」
 * 全是合法的，所以判据收窄到确定性的那一类。
 *
 * 外部链接（http/https/mailto）与纯锚点（# 开头）不在范围内；真要指向仓库外的相对路径，
 * 登记到 ALLOWED 并写明理由。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);

/** 允许指向仓库外的相对链接：文件::目标 → 理由。目前为空。 */
const ALLOWED: Readonly<Record<string, string>> = {};

const LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** 相对链接是否解析到真实文件（忽略锚点与查询串）。 */
function resolves(docPath: string, target: string): boolean {
  const path = target.split("#")[0]?.split("?")[0]?.trim() ?? "";
  if (path === "") return true;
  return existsSync(resolve(dirname(docPath), decodeURI(path)));
}

describe("文档链接", () => {
  it("每个 Markdown 相对链接都指向真实存在的文件", () => {
    const offenders: string[] = [];
    for (const file of markdownFiles(ROOT)) {
      if (file === SELF) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(LINK)) {
        const target = (match[2] ?? "").trim();
        if (target === "" || target.startsWith("#")) continue;
        if (/^(?:https?:|mailto:|tel:)/.test(target)) continue;
        if (resolves(file, target)) continue;
        const key = file.replace(ROOT + "/", "") + "::" + target;
        if (ALLOWED[key] !== undefined) continue;
        offenders.push(key);
      }
    }
    expect(offenders, "这些文档链接指向不存在的文件：修链接，或登记到 ALLOWED 并写明理由").toEqual([]);
  });

  it("扫描面非空（防止规则空转）", () => {
    const files = markdownFiles(ROOT);
    expect(files.length).toBeGreaterThanOrEqual(8);
    const links = files.reduce((sum, file) => sum + [...readFileSync(file, "utf8").matchAll(LINK)].length, 0);
    expect(links, "链接数量应可观（否则判据空转）").toBeGreaterThanOrEqual(10);
    expect(ALLOWED["__self_check__"]).toBeUndefined();
  });

  it("判据本身有效：能识别失效链接、放过外部链接与锚点", () => {
    const dir = join(ROOT, "test");
    expect(resolves(join(dir, "README.md"), "../README.md")).toBe(true);
    expect(resolves(join(dir, "README.md"), "./does-not-exist.md")).toBe(false);
    expect(resolves(join(dir, "README.md"), "#section")).toBe(true);
  });
});
