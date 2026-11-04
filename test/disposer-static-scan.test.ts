import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 注册/定时器可回收性静态扫描锁。
 *
 * 官方依据：`AGENTS.md`「Registrations are effects」——每个贡献都经
 * `ctx.effect()`/`ctx.on()` 持有 disposer；`packages/AGENTS.md`「Registry
 * contributions prove disposal」；`general.md`「Dispose must reach quiescence」
 * 与「Clear the timer in the owning effect」。2026-11-04 审计把「每处 register/
 * timer 的 disposer 静态扫描」列为规则锁盲区（RULE-044/046/086）：这类遗漏在
 * 单元测试里不会暴露（测试自己创建 Context，泄漏的是插件 fiber/宿主事件循环）。
 *
 * 判据（只看 `packages/*\/{src,client}/**\/*.{ts,tsx}`，不含包内 test/）：
 * 1. 每一次 `X.register(...)`（服务/槽/路由/命令/协议贡献）都必须落在一个可回收
 *    原语的实参区间内：`ctx.effect(`、`ctx.inject(`、`ctx.slots.inject(`（官方
 *    文档：slots.inject 的贡献随调用者 fiber 离开）、或客户端 `useEffect(`。
 *    逐个例外登记在 ALLOWED 并写明理由（登记项必须被真实命中，防止白名单腐烂）。
 * 2. `setTimeout` / `setInterval` 必须被赋值（`= setTimeout` 形态）且同文件存在
 *    对应的 `clearTimeout` / `clearInterval`；或该次调用登记在 ALLOWED 并说明
 *    为何无需清理（如 `new Promise` 里的一次性 sleep——随 Promise settle 结束）。
 *    `ctx.on(...)` 本身即官方 effect 原语，不在此判据内（由第 1 条的注册面覆盖）。
 *
 * 判据用「结构掩码」而非朴素 grep：注释与字符串字面量内容先替换成空格，避免
 * 注释里的示例、错误消息里的 `register(` 造成误报。
 *
 * 反向验证方式：把任一 `ctx.effect(() => x.register(...))` 拆成裸 `x.register(...)`
 * → 本锁报红；给某个 `setTimeout` 删掉配对 clear → 报红；还原后绿。
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/**
 * 允许的例外：`相对路径::类别::调用行规范化文本` → 理由。
 * 新增前先问：能不能改成 effect/显式清理？不能才登记。
 */
const ALLOWED: Readonly<Record<string, string>> = {
  "packages/provider-usage/src/index.ts::register::registry.register(provider, entry.querier, entry.displayName)":
    "服务级注册：ProviderUsageRegistry 的 Map 生命周期随插件 fiber（Service 由 Cordis 托管），"
    + "内置 querier 注册不需要独立 disposer；第三方经 ctx.providerUsage.register 自己持有 effect。",
};

/** 可回收原语：注册调用落在这些调用的实参区间内即视为安全。 */
const EFFECT_MARKERS: readonly RegExp[] = [
  /ctx\.effect\s*\(/g,
  /ctx\.inject\s*\(/g,
  /\.slots\.inject\s*\(/g,
  /useEffect\s*\(/g,
];

const REGISTRATION_RE = /(?<![\w$])[\w$.]*\.register\s*\(/g;
const TIMER_RE = /\b(?:globalThis\.|window\.)?(setTimeout|setInterval)\s*\(/g;

interface RegistryScan {
  /** 未被可回收原语包住的 `.register(` 调用。 */
  registrations: { line: number; call: string }[];
  /** 未赋值或缺少配对 clear 的定时器调用。 */
  timers: { line: number; call: string; kind: string }[];
  /** 扫描统计，用于非空转守卫。 */
  stats: { registrationOccurrences: number; timerOccurrences: number; effectRanges: number };
}

/** 把注释与字符串字面量内容替换成空格（保留换行/长度），避免误报。 */
function mask(text: string): string {
  const out = [...text];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") { out[i] = " "; i += 1; }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
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

/** 起止括号配对的实参区间 `[openParenIndex, closeParenIndex]`。 */
function argumentRange(masked: string, openParenIndex: number): [number, number] | undefined {
  let depth = 0;
  for (let i = openParenIndex; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return [openParenIndex, i];
    }
  }
  return undefined;
}

/** 所有可回收原语调用的实参区间。 */
function effectRanges(masked: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const marker of EFFECT_MARKERS) {
    marker.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = marker.exec(masked)) !== null) {
      const open = marker.lastIndex - 1;
      const range = argumentRange(masked, open);
      if (range !== undefined) ranges.push(range);
    }
  }
  return ranges;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** 提取调用所在行的规范化文本（用于白名单键的稳定性与审计可读性）。 */
function callLine(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

/**
 * 扫描一段源码的注册与定时器可回收性。
 *
 * @param source - TS/TSX 源码文本。
 * @returns 违规调用与扫描统计。
 */
export function scanDisposers(source: string): RegistryScan {
  const masked = mask(source);
  const ranges = effectRanges(masked);
  // `new Promise(fn)` 里的裸 setTimeout 属 sleep 语义：timer 随 Promise settle
  // 结束，不持有跨操作句柄（判据不是「裸」而是「是否残留句柄」）。按实参区间识别。
  const promiseRanges: [number, number][] = [];
  {
    const marker = /new Promise\s*\(/g;
    let promiseMatch: RegExpExecArray | null;
    while ((promiseMatch = marker.exec(masked)) !== null) {
      const range = argumentRange(masked, marker.lastIndex - 1);
      if (range !== undefined) promiseRanges.push(range);
    }
  }
  const registrations: { line: number; call: string }[] = [];
  const timers: { line: number; call: string; kind: string }[] = [];
  let registrationOccurrences = 0;
  let timerOccurrences = 0;

  REGISTRATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REGISTRATION_RE.exec(masked)) !== null) {
    registrationOccurrences += 1;
    const index = REGISTRATION_RE.lastIndex - 1;
    if (ranges.some(([open, close]) => index > open && index < close)) continue;
    const call = callLine(source, index);
    registrations.push({ line: lineOf(source, index), call });
  }

  const hasClear = {
    setTimeout: /clearTimeout\s*\(/.test(masked),
    setInterval: /clearInterval\s*\(/.test(masked),
  };
  TIMER_RE.lastIndex = 0;
  while ((match = TIMER_RE.exec(masked)) !== null) {
    timerOccurrences += 1;
    const kind = match[1] as "setTimeout" | "setInterval";
    // 调用起点（含可选 `globalThis.`/`window.` 前缀）——赋值判定必须看它之前的文本。
    const index = match.index;
    const lineStart = source.lastIndexOf("\n", index) + 1;
    const prefix = source.slice(lineStart, index).trimEnd();
    // 赋值形态：`x = setTimeout(...)` / `x.current = setTimeout(...)` / `const x = setTimeout(...)`。
    // 排除比较/箭头（`a === b`、`resolve =>`）与裸调用。
    const assigned = /[\w$.]+\s*=\s*$/.test(prefix) && !/[=!<>]=\s*$/.test(prefix) && !/=>\s*$/.test(prefix);
    if (promiseRanges.some(([open, close]) => index > open && index < close)) continue;
    if (assigned && hasClear[kind]) continue;
    // 赋值但同文件没有配对 clear：按「未清理」处理；裸调用同样按未清理处理。
    timers.push({ line: lineOf(source, index), call: callLine(source, index), kind });
  }

  return { registrations, timers, stats: { registrationOccurrences, timerOccurrences, effectRanges: ranges.length } };
}

interface SourceFile {
  rel: string;
  file: string;
}

/** 枚举 packages/<pkg>/{src,client} 下的源码文件（排除包内 test/ 与 d.ts）。 */
function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string, relBase: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "test") continue;
      const full = join(dir, entry.name);
      const rel = `${relBase}/${entry.name}`;
      if (entry.isDirectory()) walk(full, rel);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push({ rel, file: full });
    }
  };
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const face of ["src", "client"]) {
      const dir = join(ROOT, "packages", entry.name, face);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      walk(dir, `packages/${entry.name}/${face}`);
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

const FILES = sourceFiles();

/** 白名单键：`相对路径::类别::调用行文本`。 */
function keyOf(rel: string, kind: "register" | "timer", call: string): string {
  return `${rel}::${kind}::${call}`;
}

describe("注册/定时器可回收性静态扫描", () => {
  it("扫描面非空（防止规则空转）", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(40);
    let registrations = 0;
    let timers = 0;
    let effects = 0;
    for (const { file } of FILES) {
      const scan = scanDisposers(readFileSync(file, "utf8"));
      registrations += scan.stats.registrationOccurrences;
      timers += scan.stats.timerOccurrences;
      effects += scan.stats.effectRanges;
    }
    expect(registrations, "注册调用数量应可观").toBeGreaterThanOrEqual(8);
    expect(timers, "定时器调用数量应可观").toBeGreaterThanOrEqual(5);
    expect(effects, "可回收原语数量应可观").toBeGreaterThanOrEqual(5);
  });

  const consumedWhitelist = new Set<string>();

  for (const { rel, file } of FILES) {
    it(`${rel}: 注册在可回收原语内、定时器有清理`, () => {
      const scan = scanDisposers(readFileSync(file, "utf8"));
      const offenders: string[] = [];
      for (const { line, call } of scan.registrations) {
        const key = keyOf(rel, "register", call);
        if (ALLOWED[key] !== undefined) { consumedWhitelist.add(key); continue; }
        offenders.push(`L${line} 注册未被可回收原语包住: ${call}`);
      }
      for (const { line, call, kind } of scan.timers) {
        const key = keyOf(rel, "timer", call);
        if (ALLOWED[key] !== undefined) { consumedWhitelist.add(key); continue; }
        offenders.push(`L${line} ${kind} 未赋值或缺少配对 clear: ${call}`);
      }
      expect(offenders, `${rel}: ${offenders.join("；")}`).toEqual([]);
    });
  }

  it("白名单本身可审计：条目都带理由且真实命中（防腐烂）", () => {
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(reason.trim().length, `${key}: 白名单必须写理由`).toBeGreaterThan(5);
      expect(consumedWhitelist.has(key), `${key}: 白名单已过期（当前扫描面没有命中）——删掉它`).toBe(true);
    }
    expect(ALLOWED["__self_check__"]).toBeUndefined();
  });

  it("判据本身有效：能识别裸注册/未清理定时器，放过 effect 包裹与已清理定时器", () => {
    const cases: [string, { registrations: number; timers: number }][] = [
      // 裸注册 → 违规。
      ["const d = ctx.webServer.register({ path: '/x' })", { registrations: 1, timers: 0 }],
      // effect 包裹 → 通过。
      ["ctx.effect(() => ctx.commands.register(def), 'label')", { registrations: 0, timers: 0 }],
      // slots.inject 包裹 → 通过。
      ["ctx.slots.inject('x', () => ctx.slots.register({ name: 'x' }, C))", { registrations: 0, timers: 0 }],
      // 客户端 useEffect 内注册 → 通过。
      ["useEffect(() => { const d = svc.register(x); return () => d() }, [])", { registrations: 0, timers: 0 }],
      // 赋值 + 同文件 clear → 通过。
      ["const t = setTimeout(fn, 10); clearTimeout(t)", { registrations: 0, timers: 0 }],
      // 裸 setTimeout 且无 clear → 违规。
      ["setTimeout(fn, 10)", { registrations: 0, timers: 1 }],
      // 赋值但没有 clear → 违规。
      ["const t = setTimeout(fn, 10)", { registrations: 0, timers: 1 }],
      // new Promise 里的裸 setTimeout 属 sleep 语义 → 通过。
      ["await new Promise(resolve => setTimeout(resolve, 10))", { registrations: 0, timers: 0 }],
      // 注释/字符串里的示例不算。
      ["// ctx.webServer.register({})\nconst s = 'register('", { registrations: 0, timers: 0 }],
    ];
    for (const [source, expected] of cases) {
      const scan = scanDisposers(source);
      expect(scan.registrations, source).toHaveLength(expected.registrations);
      expect(scan.timers, source).toHaveLength(expected.timers);
    }
  });
});
