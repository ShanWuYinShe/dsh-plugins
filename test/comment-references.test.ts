import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 注释里的跨文件引用回归。
 *
 * 代码注释大量使用「见 <文件>」「见 <文件> 的 <符号>」「见 <符号>」来指路。
 * 拆模块时这些指引最容易腐烂：符号搬走后注释还指着旧文件，读者按图索骥找不到东西。
 * 本轮审计就抓到一例（catalog-timers.ts 里的「见 claimFlipRefreshes」——那个用例早已
 * 改名，全仓搜不到）。
 *
 * 三条判据：
 * 1. 「见 <文件>」——文件名必须真实存在（按 basename 在全仓 .ts/.tsx 里找，含 test/）；
 * 2. 「见 <文件> 的 <符号>」——该符号必须出现在被指向的文件里；
 * 3. 「见 <符号>」——符号必须出现在实现或测试代码里（词边界匹配，注释不计入语料，
 *    否则注释自己就能把自己证明成存在）。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "lib", "dist", ".worktrees", ".workwork", ".agents", "coverage"]);
const SOURCE_RE = /\.tsx?$/;

function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

/** 去掉注释后的代码文本（语料不能含注释，否则检查恒真）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/gm, "$1");
}

/**
 * 文件里的注释文本（块注释 + 行注释）。
 *
 * 连续的 // 行合并成一段：引用常写成「……见」换行接文件名，逐行扫描会漏掉这种
 * 跨行指引（本文件自己的第一条修复就是这个形态）。
 */
function commentsOf(text: string): string[] {
  const comments = [...text.matchAll(/\/\*[\s\S]*?\*\//g)].map((match) => match[0]);
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) comments.push(run.join("\n"));
    run = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) run.push(trimmed);
    else flush();
  }
  flush();
  return comments;
}

/** 本文件自己举例说明判据，不该被自己的规则扫描（否则示例即违规）。 */
const SELF = fileURLToPath(import.meta.url);
const allFiles = collect(ROOT).filter((file) => file !== SELF);
const byName = new Map<string, string>();
for (const file of allFiles) {
  const name = basename(file);
  if (!byName.has(name)) byName.set(name, file);
}
const strip = (file: string): string => stripComments(readFileSync(file, "utf8"));
// 语料：实现（src/client/scripts）与测试分开——测试名也是合法的引用目标。
const corpus = allFiles.filter((file) => /\/(src|client|scripts)\//.test(file)).map(strip).join("\n");
const testCorpus = allFiles.filter((file) => /\/test\//.test(file)).map(strip).join("\n");

const presentIn = (text: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(text);

describe("注释里的跨文件引用仍然成立", () => {
  const refs: { file: string; comment: string }[] = [];
  for (const file of allFiles) {
    for (const comment of commentsOf(readFileSync(file, "utf8"))) refs.push({ file, comment });
  }

  it("「见 <文件>」指向的文件存在", () => {
    const missing: string[] = [];
    for (const { comment } of refs) {
      // `见` 与路径常分行写成「……见」换行接 `// <路径>`；`//` 后还有空格，
      // 必须一并容忍，否则这条判据会空转通过（反向验证时踩到）。
      for (const match of comment.matchAll(/见\s*(?:\/\/\s*)?([A-Za-z0-9_./-]+\.tsx?)/g)) {
        if (!byName.has(basename(match[1]!))) missing.push(match[1]!);
      }
    }
    expect(missing, "注释指向了不存在的文件").toEqual([]);
  });

  it("「见 <文件> 的 <符号>」的符号确实在那个文件里", () => {
    const wrong: string[] = [];
    for (const { comment } of refs) {
      for (const match of comment.matchAll(/见\s*(?:\/\/\s*)?([A-Za-z0-9_./-]+\.tsx?)\s*的\s*`?([A-Za-z_$][\w$]*)`?/g)) {
        const target = byName.get(basename(match[1]!));
        if (target === undefined) continue;
        if (!presentIn(readFileSync(target, "utf8"), match[2]!)) {
          wrong.push(`${match[2]} 不在 ${match[1]}`);
        }
      }
    }
    expect(wrong, "注释指向的文件里没有该符号").toEqual([]);
  });

  it("「见 <符号>」的符号在实现或测试里存在", () => {
    const missing: string[] = [];
    for (const { comment } of refs) {
      for (const match of comment.matchAll(/见\s*(?:\/\/\s*)?`?([A-Za-z_$][\w$]*)`?/g)) {
        const name = match[1]!;
        // 后面紧跟文件扩展名的是路径（由前两条判据负责），跳过。
        const rest = comment.slice(match.index! + match[0].length);
        if (/^\.[A-Za-z0-9]+/.test(rest)) continue;
        if (!presentIn(corpus, name) && !presentIn(testCorpus, name)) missing.push(name);
      }
    }
    expect(missing, "注释指向了实现里不存在的符号").toEqual([]);
  });

  it("判据本身有效（三条模式都真的抽到引用，防止空转通过）", () => {
    const fileRefs = refs.flatMap(({ comment }) =>
      [...comment.matchAll(/见\s*(?:\/\/\s*)?([A-Za-z0-9_./-]+\.tsx?)/g)].map((match) => match[1]!),
    );
    const symbolRefs = refs.flatMap(({ comment }) =>
      [...comment.matchAll(/见\s*(?:\/\/\s*)?`?([A-Za-z_$][\w$]*)`?/g)].map((match) => match[1]!),
    );
    expect(refs.length).toBeGreaterThan(100);
    expect(fileRefs.length, "「见 <文件>」应抽到引用").toBeGreaterThan(5);
    expect(symbolRefs.length, "「见 <符号>」应抽到引用").toBeGreaterThan(10);
  });
});
