import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 源码结构卫生回归。
 *
 * 本仓没有配 linter / formatter（package.json 里没有相应脚本与依赖），所以「export 关键字
 * 不能与注释粘连」「文件以换行结尾」这类约定只能靠测试守。本轮审计抓到 11 处 export 被粘到
 * 文档注释上的畸形写法（export 紧跟块注释开头、以及注释收尾紧跟 export），全部是脚本化拆分
 * 时把注释与声明拼错行留下的——读者第一眼会以为 export 修饰的是注释。
 *
 * 三条判据（当前全仓 0 违规，加锁只为防复发）：
 * 1. 没有「export 紧跟块注释开头」或「注释收尾紧跟 export」的行；
 * 2. 每个文件以换行结尾（避免 diff 里的 No newline at end of file 噪音）；
 * 3. 没有 CRLF 行尾与制表符缩进。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);
const SOURCE_RE = /\.(ts|tsx|mjs|json|md)$/;

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

const files = collect(ROOT);

/** 一次读盘：文件 → 文本（三个用例共用，避免同一份文件被反复读取）。 */
const TEXTS = new Map<string, string>(files.map((file) => [file, readFileSync(file, "utf8")]));

describe("源码结构卫生", () => {
  it("export 关键字不与注释粘连", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = TEXTS.get(file) ?? "";
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        if (/^export\s+\/\*/.test(line) || /\*\/export\s/.test(line)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${index + 1}`);
        }
      });
    }
    expect(offenders, "export 被拼到注释行上：请把注释与声明分行").toEqual([]);
  });

  it("每个文件以换行结尾", () => {
    const offenders = files.filter((file) => {
      const text = TEXTS.get(file) ?? "";
      return text.length > 0 && !text.endsWith("\n");
    });
    expect(offenders.map((file) => file.slice(ROOT.length + 1)), "文件缺少结尾换行").toEqual([]);
  });

  it("没有 CRLF 行尾与制表符缩进", () => {
    const crlf: string[] = [];
    const tabs: string[] = [];
    for (const file of files) {
      const text = TEXTS.get(file) ?? "";
      if (text.includes("\r\n")) crlf.push(file.slice(ROOT.length + 1));
      if (text.includes("\t")) tabs.push(file.slice(ROOT.length + 1));
    }
    expect(crlf, "存在 CRLF 行尾").toEqual([]);
    expect(tabs, "存在制表符缩进").toEqual([]);
  });

  it("判据本身有效（扫到了足够多的文件）", () => {
    expect(files.length).toBeGreaterThan(150);
  });
});
