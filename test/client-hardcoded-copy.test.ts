import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * client 硬编码产品文案锁：产品可见文案必须走 typed locale 字典（`t`）或
 * 已本地化的数据，不能在 TSX 里直写。
 *
 * 官方依据：`packages/client/AGENTS.md`「Styling and localization」——每个
 * product-visible string（含 text、accessibility names、tooltips、placeholders）
 * 必须住在 typed locale dictionary 里，经标准 `t` seat 或已本地化 prop 到达组件；
 * 对应的官方门禁是 `verify-client-ui-i18n`（本仓没有该脚本，用这把锁等价覆盖）。
 * 2026-11-04 审计把「client 硬编码文案」列为规则锁盲区 #5：`locale-keys.test.ts`
 * 只查「定义的 key 有引用 + en/zh 键集一致」，查不到 TSX 里直写的文案——这类
 * 退化没有自然信号（没有测试会红，只有非英文界面里冒出英文/中文混杂才可见）。
 *
 * 判据（只看 `packages/*\/client/**\/*.tsx`）：
 * 1. 可见属性的**字符串字面量**值：`aria-label` / `aria-description` /
 *    `aria-placeholder` / `alt` / `title` / `placeholder` / `label` / `description`
 *    直接写死一段文字 → 违规（用 `t(...)` 或传数据值；`title={row.name}` 这类
 *    数据表达式不算文案）；空串与纯符号（如 `''`、`'-'`）不算产品文案；
 * 2. JSX 文本节点里含至少两个连续字母的可见文字 → 违规（用 `{t(...)}`）；
 *    纯符号/空白（`·`、`/`、`：`）不算。
 *
 * 误报风险（已做判据自检，见文件末尾用例）：TS 泛型的 `<`/`>` 不是 JSX 标签；
 * 因此文本节点检测只在「开标签」上做锚点，并要求标签前一个非空白字符不是标识符
 * /`)`/`]`（排除 `Array<T>`、`foo<T>(x)` 这类类型参数上下文）。样式/类名等
 * 技术字符串（className/style/`data-*`）不在可见属性集合内，不会误报。
 *
 * 反向验证方式：在任一 client TSX 里把 `{t('refresh')}` 改成 `"Refresh"`（放
 * `aria-label`）或在 JSX 里直接写 `Refresh` 文本 → 本锁必须报红；还原后绿。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 承载产品可见文案的 JSX 属性名（动态数据值用表达式，不在此列）。 */
const VISIBLE_ATTRIBUTES = [
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "alt",
  "title",
  "placeholder",
  "label",
  "description",
] as const;

/**
 * 允许的例外：`包相对路径::类别::文本` → 理由。
 * 只有「确实是产品文案但无法走 `t`」的极少数场景才允许登记；新增前先确认
 * 不是把本该本地化的 copy 当成例外。当前全仓 0 例外（正确状态）。
 */
const ALLOWED: Readonly<Record<string, string>> = {};

interface PackageDir {
  name: string;
  dir: string;
}

/** 枚举 packages/<pkg>/client 下的 TSX 源文件。 */
function tsxFiles(): { rel: string; file: string }[] {
  const out: { rel: string; file: string }[] = [];
  const packagesDir = join(ROOT, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const clientDir = join(packagesDir, entry.name, "client");
    let walk: string[] = [];
    try {
      walk = readdirSync(clientDir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const name of walk) {
      if (!name.endsWith(".tsx")) continue;
      const file = join(clientDir, name);
      if (!statSync(file).isFile()) continue;
      out.push({ rel: `packages/${entry.name}/client/${name.split("\\").join("/")}`, file });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function packages(): PackageDir[] {
  const packagesDir = join(ROOT, "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: join(packagesDir, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 把注释与字符串字面量内容替换成空格（保留换行与长度），用于「结构扫描」：
 * 这样 JSX 标签/文本的位置与原文一一对应，但字符串里的 `<`、`>` 不会干扰判定。
 * 单引号/双引号/模板字符串都处理；模板字符串里的 `${...}` 内容一律视为
 * 非文本（表达式），不参与文案判定。
 *
 * @param text - 源码原文。
 * @returns 与原文等长的结构掩码文本。
 */
function maskStringsAndComments(text: string): string {
  const out = [...text];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") { out[i] = " "; i += 1; }
      continue;
    }
    if (ch === "/" && next === "*") {
      out[i] = " "; out[i + 1] = " "; i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      if (i < text.length) { out[i] = " "; out[i + 1] = " "; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") { out[i] = " "; out[i + 1] = " "; i += 2; continue; }
        if (text[i] === quote) { i += 1; break; }
        if (text[i] !== "\n") out[i] = " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** 一行是否只是注释（结构掩码后整行空白且原文非空 → 注释行）。 */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** 文本节点是否是「产品可见文案」：含至少两个连续字母，且不是纯表达式符号。 */
function looksLikeCopy(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (!/[A-Za-z]{2,}/.test(trimmed)) return false;
  // 允许的标点集合之外的字符说明这不是纯文本节点（例如类型注解/比较残留），跳过。
  // 冒号与 `=>` 是 TS 类型语法（`(method: M, ...args: Parameters`）的强信号：
  // 真正的产品文案不会在 JSX 文本节点里带 TS 冒号（中文冒号是全角，不在此列）。
  if (trimmed.includes(":") || trimmed.includes("=>")) return false;
  return /^[A-Za-z0-9\s.,!?;'"%·—–\-/()]+$/u.test(trimmed);
}

interface Finding {
  line: number;
  kind: "attribute" | "text";
  detail: string;
}

/**
 * 扫描一段 TSX 源码，返回硬编码产品文案。
 *
 * @param source - TSX 源码文本（可含文件头注释）。
 * @returns 违规位置（行号从 1 起）与证据。
 */
export function findHardcodedCopy(source: string): Finding[] {
  const masked = maskStringsAndComments(source);
  const findings: Finding[] = [];

  // 1) 可见属性的字符串字面量值。
  const attrRe = new RegExp(
    `(?:^|[\\s{<])(${VISIBLE_ATTRIBUTES.join("|")})\\s*=\\s*(["'])((?:\\\\.|(?!\\2)[^\\\\])*)\\2`,
    "gu",
  );
  for (const match of source.matchAll(attrRe)) {
    const raw = match[3] ?? "";
    if (!/[A-Za-z]{2,}/.test(raw)) continue; // 空串 / 纯符号 / 数据占位
    const line = lineOf(source, match.index ?? 0);
    const key = `${line}::attribute::${raw}`;
    if (ALLOWED[key] !== undefined) continue;
    findings.push({ line, kind: "attribute", detail: `${match[1]}="${raw}"` });
  }

  // 2) JSX 文本节点：以开标签为锚点，读到下一个 `<` / `{` 为止。
  const openingTagRe = /<([A-Za-z][\w.$-]*)([^<>]*?)>/gu;
  for (const match of masked.matchAll(openingTagRe)) {
    const tagName = match[1] ?? "";
    const attrs = match[2] ?? "";
    // 自闭合标签没有文本节点；`/>` 已被 `>` 匹配吞掉，靠 attrs 末尾判断。
    if (attrs.trimEnd().endsWith("/")) continue;
    // 排除类型参数上下文：标签前一个非空白字符是标识符 / `)` / `]` / `:` 等。
    const before = masked.slice(Math.max(0, (match.index ?? 0) - 1), match.index ?? 0);
    const prevNonSpace = masked.slice(0, match.index ?? 0).trimEnd().slice(-1);
    void before;
    if (prevNonSpace !== "" && !"([{,>=?:;&|!~^".includes(prevNonSpace)) continue;
    void tagName;
    const start = (match.index ?? 0) + match[0].length;
    let end = start;
    while (end < source.length) {
      const ch = source[end] as string;
      if (ch === "<" || ch === "{") break;
      if (masked[end] !== source[end]) break; // 进入字符串/注释区：不是文本节点
      end += 1;
    }
    const text = source.slice(start, end);
    if (!looksLikeCopy(text)) continue;
    const line = lineOf(source, start);
    const key = `${line}::text::${text.trim()}`;
    if (ALLOWED[key] !== undefined) continue;
    findings.push({ line, kind: "text", detail: text.trim() });
  }

  return findings;
}

const FILES = tsxFiles();

describe("client 硬编码产品文案", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(FILES.length, "应扫到多包 client TSX").toBeGreaterThanOrEqual(15);
    expect(packages().length).toBeGreaterThanOrEqual(4);
    const visibleAttributeOccurrences = FILES.reduce((sum, { file }) => {
      const text = readFileSync(file, "utf8");
      return sum + VISIBLE_ATTRIBUTES.reduce((count, attr) => count + (text.match(new RegExp(`${attr}\\s*=\\s*\\{`, "gu"))?.length ?? 0), 0);
    }, 0);
    expect(visibleAttributeOccurrences, "可见属性（表达式形态）数量应可观，否则判据空转").toBeGreaterThanOrEqual(15);
  });

  for (const { rel, file } of FILES) {
    it(`${rel}: 产品可见文案都走 t/locale`, () => {
      const findings = findHardcodedCopy(readFileSync(file, "utf8"));
      expect(
        findings,
        [
          `${rel}: 硬编码产品文案（请改用 t(...) 或已本地化数据）`,
          ...findings.map((f) => `  L${f.line} [${f.kind}] ${f.detail}`),
        ].join("\n"),
      ).toEqual([]);
    });
  }

  it("判据本身有效：能识别硬编码属性与 JSX 文本，放过 t/数据表达式与泛型", () => {
    const cases: [string, number][] = [
      ['const a = <button aria-label="Refresh" />', 1],
      ["const a = <button aria-label='Refresh' />", 1],
      ["const a = <p>No data</p>", 1],
      ['const a = <div title="Settings">Cancel</div>', 2],
      ["const a = <button aria-label={t('refresh')} />", 0],
      ["const a = <p>{t('empty')}</p>", 0],
      ["const a = <td title={row.name}>{row.name}</td>", 0],
      ["const a = <span title={resetHint} />", 0],
      // 泛型不是 JSX 标签；比较运算符也不是。
      ["const x: Array<string> = [];", 0],
      ["const y = a < b ? 1 : 2;", 0],
      // 纯符号文本不是产品文案。
      ["const a = <span>·</span>;", 0],
      ['const a = <div className="pu-pill-btn" data-x="1" />', 0],
    ];
    for (const [source, expected] of cases) {
      expect(findHardcodedCopy(source), source).toHaveLength(expected);
    }
  });

  it("例外白名单本身可审计（条目必须带理由，且当前为空）", () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(reason.trim().length, `${key}: 白名单必须写理由`).toBeGreaterThan(5);
    }
    expect(ALLOWED["__self_check__"]).toBeUndefined();
    expect(readFileSync(fileURLToPath(import.meta.url), "utf8")).toContain("const ALLOWED");
  });
});
