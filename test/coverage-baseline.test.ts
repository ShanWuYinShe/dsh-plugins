import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  BASELINE_PATH,
  BASELINE_VERSION,
  DEFAULT_TOLERANCE_PP,
  METRICS,
  ROOT,
  buildBaseline,
  evaluateCoverage,
  normalizePct,
  parseCoverageConfig,
  repoRelativePath,
} from "../scripts/coverage-ratchet.mjs";
import type { CoverageSummary, SummaryMetric } from "../scripts/coverage-ratchet.mjs";

/**
 * 逐文件覆盖率棘轮基线锁。
 *
 * 背景：官方规则 RULE-088（docs/testing.md「Coverage gate」）的门禁口径是
 * `packages/*\/src` 逐文件 100%。本仓尚未达成，改用版本化逐文件基线
 * `scripts/coverage-baseline.json` + `scripts/coverage-ratchet.mjs` 先锁「不回退」：
 * 每个纳入 coverage 的源文件不得低于基线（容差 0.2pp），新增文件须达全局阈值，
 * 消失文件由 `--write` 清理。基线/配置/覆盖率面三者一旦漂移，棘轮会误判
 * （放行回退或永远红），因此必须有这把锁保证它们同源。
 *
 * 本锁只读磁盘与配置（不依赖 `coverage/` 产物），因此普通 `vitest run` 也能跑：
 * 1. 基线文件存在、可解析、version/tolerance 合法，每个文件四个指标都是 0–100 数字；
 * 2. 基线里的 `globalThresholds` 与 `vitest.config.ts` 的 thresholds 完全一致
 *    （两处手写会漂移：配置上调后新增文件仍按旧阈值放行）；
 * 3. 基线记录的「覆盖率面」与 `vitest.config.ts` 的 include/exclude 从磁盘推导出的
 *    源文件集合**完全一致**——缺记录=新文件未入基线，多记录=过期/文件消失；
 * 4. 容差与写入逻辑自检（含反向样例）：回退 1pp 必红、0.1pp 容差内放行、
 *    新增文件低于全局阈值必红、过期记录必须在 `--write` 时清理、默认拒绝放宽。
 *
 * 反向验证方式（本锁的设计约束，改动棘轮后必须重做）：
 * - 手动把基线里任一文件的某个指标 +1pp → `node scripts/coverage-ratchet.mjs` 报红；
 *   还原后绿（CI 由 `bun run test:coverage` 执行同一校验）。
 * - 在 `packages/<pkg>/src` 新增一个源文件而不刷新基线 → 本锁「覆盖率面一致」用例报红；
 *   `bun run coverage:ratchet --write` 后绿。
 */

interface FileCoverage {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/** 解析版本化基线（结构问题由用例断言，不在 import 期抛错）。 */
function readBaseline(): {
  version?: unknown;
  tolerancePp?: unknown;
  globalThresholds?: Record<string, unknown>;
  files?: Record<string, FileCoverage>;
} {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as never;
}

/** 读取 vitest.config.ts 的 coverage 面（必须可解析，否则锁直接红）。 */
function readCoverageConfig() {
  const config = parseCoverageConfig(readFileSync(join(ROOT, "vitest.config.ts"), "utf8"));
  if (config === undefined) throw new Error("vitest.config.ts 的 coverage.include/exclude/thresholds 解析失败");
  return config;
}

/**
 * 极简 glob → RegExp（只覆盖本仓 vitest coverage include/exclude 用到的形态）：
 * `**\/` 匹配零或多级目录、`**` 匹配任意字符、`*` 匹配单级非空段、`?` 匹配单字符。
 *
 * @param pattern - glob 模式。
 * @returns 锚定整条路径的正则。
 */
function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * 从磁盘推导 coverage 面（与 vitest include/exclude 同语义）。
 *
 * @returns 仓库相对路径（POSIX）排序数组。
 */
function expectedCoverageFace(include: readonly string[], exclude: readonly string[]): string[] {
  const includeRes = include.map(globToRegExp);
  const excludeRes = exclude.map(globToRegExp);
  const out: string[] = [];
  const packagesDir = join(ROOT, "packages");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
      const rel = relative(ROOT, full).split("\\").join("/");
      if (!includeRes.some((re) => re.test(rel))) continue;
      if (excludeRes.some((re) => re.test(rel))) continue;
      out.push(rel);
    }
  };
  if (!existsSync(packagesDir)) return out;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const face of ["src", "client"]) {
      const dir = join(packagesDir, entry.name, face);
      if (existsSync(dir)) walk(dir);
    }
  }
  return out.sort();
}

/** 覆盖率汇总构造器：只填四个指标，其余字段无关。 */
function summaryOf(files: Record<string, Partial<FileCoverage>>): CoverageSummary {
  const metric = (pct: number): SummaryMetric => ({ total: 1, covered: 1, skipped: 0, pct });
  const summary: CoverageSummary = {
    total: { statements: metric(0), branches: metric(0), functions: metric(0), lines: metric(0) },
  };
  for (const [file, metrics] of Object.entries(files)) {
    summary[file] = Object.fromEntries(METRICS.map((key) => [key, metric(metrics[key] ?? 0)]));
  }
  return summary;
}

/** 基线构造器（key 直接用相对路径，避免依赖当前仓库绝对路径）。 */
function baselineOf(
  files: Record<string, FileCoverage>,
  options: { tolerancePp?: number; globalThresholds?: Record<string, number> } = {},
): {
  version: number;
  tolerancePp: number;
  globalThresholds: Record<string, number>;
  files: Record<string, FileCoverage>;
} {
  return {
    version: BASELINE_VERSION,
    tolerancePp: options.tolerancePp ?? DEFAULT_TOLERANCE_PP,
    globalThresholds: options.globalThresholds ?? {
      statements: 81,
      branches: 76,
      functions: 79,
      lines: 84,
    },
    files,
  };
}

const CONFIG = readCoverageConfig();
const CONFIG_THRESHOLDS = CONFIG.thresholds as Record<string, number>;
const BASELINE = readBaseline();
const BASELINE_FILES = BASELINE.files ?? {};
const FACE = expectedCoverageFace(CONFIG.include, CONFIG.exclude);

describe("逐文件覆盖率棘轮基线", () => {
  it("基线文件存在、格式版本与容差合法（防止棘轮静默失效）", () => {
    expect(existsSync(BASELINE_PATH), `缺基线文件 ${relative(ROOT, BASELINE_PATH)}`).toBe(true);
    expect(BASELINE.version).toBe(BASELINE_VERSION);
    expect(BASELINE.tolerancePp).toBe(DEFAULT_TOLERANCE_PP);
    const files = Object.entries(BASELINE_FILES);
    expect(files.length, "基线文件数应覆盖四包 src/client 主体").toBeGreaterThanOrEqual(150);
    for (const [file, metrics] of files) {
      for (const metric of METRICS) {
        const value = metrics[metric];
        expect(typeof value, `${file}: ${metric} 必须是数字`).toBe("number");
        expect(value, `${file}: ${metric} 应在 0–100 之间`).toBeGreaterThanOrEqual(0);
        expect(value, `${file}: ${metric} 应在 0–100 之间`).toBeLessThanOrEqual(100);
      }
    }
  });

  it("基线里的全局阈值与 vitest.config.ts 完全一致（单一事实源）", () => {
    expect(CONFIG.include.length).toBeGreaterThanOrEqual(3);
    expect(CONFIG.exclude.length).toBeGreaterThanOrEqual(3);
    for (const metric of METRICS) {
      expect(typeof CONFIG_THRESHOLDS[metric], `vitest.config.ts 缺 thresholds.${metric}`).toBe("number");
      expect(CONFIG_THRESHOLDS[metric]).toBeGreaterThanOrEqual(50);
      expect(CONFIG_THRESHOLDS[metric]).toBeLessThanOrEqual(100);
      expect(
        BASELINE.globalThresholds?.[metric],
        `基线 globalThresholds.${metric} 与 vitest.config.ts 的 thresholds 漂移：`
          + "上调阈值后要重跑 bun run coverage:ratchet --write 刷新基线镜像值",
      ).toBe(CONFIG_THRESHOLDS[metric]);
    }
  });

  it("基线覆盖率面与 vitest include/exclude 推导出的源文件集合完全一致", () => {
    expect(FACE.length, "推导出的 coverage 面过小，判据空转").toBeGreaterThanOrEqual(150);
    const listed = Object.keys(BASELINE_FILES).sort();
    const missing = FACE.filter((file) => !listed.includes(file));
    const stale = listed.filter((file) => !FACE.includes(file));
    expect(
      missing,
      `这些源文件在 coverage 面内但基线没有记录（新文件未入基线，或基线未刷新）：\n`
        + `${missing.slice(0, 20).join("\n")}${missing.length > 20 ? `\n…还有 ${missing.length - 20} 个` : ""}`,
    ).toEqual([]);
    expect(
      stale,
      `基线里这些记录已过期（文件删除/移出 coverage 面，需 bun run coverage:ratchet --write 清理）：\n`
        + `${stale.slice(0, 20).join("\n")}${stale.length > 20 ? `\n…还有 ${stale.length - 20} 个` : ""}`,
    ).toEqual([]);
  });

  it("容差判据自检：回退必红、容差内放行、新增/过期规则正确", () => {
    const baseline = baselineOf({
      "packages/a/src/x.ts": { statements: 90, branches: 80, functions: 90, lines: 90 },
      "packages/a/src/gone.ts": { statements: 50, branches: 50, functions: 50, lines: 50 },
    });

    // 回退 1pp（超过 0.2pp 容差）→ 报红；0.1pp 在容差内 → 放行。
    const regressed = evaluateCoverage(
      summaryOf({ "packages/a/src/x.ts": { statements: 89, branches: 80, functions: 90, lines: 90 } }),
      baseline,
    );
    expect(regressed.violations.map((item) => `${item.file}:${item.metric}`)).toEqual(["packages/a/src/x.ts:statements"]);
    const withinTolerance = evaluateCoverage(
      summaryOf({ "packages/a/src/x.ts": { statements: 89.9, branches: 80, functions: 90, lines: 90 } }),
      baseline,
    );
    expect(withinTolerance.violations).toEqual([]);

    // 新增文件必须达到全局阈值：低于 → 违规；达到 → 通过。
    const newLow = evaluateCoverage(
      summaryOf({ "packages/a/src/new.ts": { statements: 80.8, branches: 90, functions: 90, lines: 90 } }),
      baseline,
    );
    expect(newLow.violations).toHaveLength(1);
    expect(newLow.violations[0]?.kind).toBe("new-file-below-global");
    expect(newLow.newFiles).toEqual(["packages/a/src/new.ts"]);
    const newOk = evaluateCoverage(
      summaryOf({ "packages/a/src/new.ts": { statements: 81, branches: 76, functions: 79, lines: 84 } }),
      baseline,
    );
    expect(newOk.violations).toEqual([]);

    // 基线有、当前覆盖率面没有 → 过期记录（强制清理，避免掩盖未来回退）。
    const staleResult = evaluateCoverage(summaryOf({}), baseline);
    expect(staleResult.stale).toEqual(["packages/a/src/gone.ts", "packages/a/src/x.ts"]);
  });

  it("写入逻辑自检：默认拒绝放宽、--lower 才放宽、新增低覆盖拒绝写入、过期记录自动清理", () => {
    const previous = baselineOf({
      "packages/a/src/x.ts": { statements: 90, branches: 80, functions: 90, lines: 90 },
      "packages/a/src/gone.ts": { statements: 50, branches: 50, functions: 50, lines: 50 },
    });
    const summary = summaryOf({
      "packages/a/src/x.ts": { statements: 60, branches: 80, functions: 90, lines: 90 },
      "packages/a/src/new.ts": { statements: 10, branches: 10, functions: 10, lines: 10 },
    });

    const refusedLower = buildBaseline(summary, previous, { globalThresholds: CONFIG_THRESHOLDS });
    expect(refusedLower.baseline).toBeUndefined();
    expect(refusedLower.lowerings).toEqual([
      { file: "packages/a/src/x.ts", metric: "statements", from: 90, to: 60 },
    ]);

    // 首次建立基线是引导（记录现状、允许低覆盖文件进入基线）；之后再 --write 时
    // 新增文件才必须达到全局阈值。
    const bootstrap = buildBaseline(
      summaryOf({ "packages/a/src/new.ts": { statements: 10, branches: 10, functions: 10, lines: 10 } }),
      undefined,
      { globalThresholds: CONFIG_THRESHOLDS },
    );
    expect(bootstrap.baseline).toBeDefined();
    expect(bootstrap.rejected).toEqual([]);
    const refusedNew = buildBaseline(
      summaryOf({ "packages/a/src/new.ts": { statements: 10, branches: 10, functions: 10, lines: 10 } }),
      baselineOf({ "packages/a/src/x.ts": { statements: 90, branches: 80, functions: 90, lines: 90 } }),
      { globalThresholds: CONFIG_THRESHOLDS },
    );
    expect(refusedNew.baseline).toBeUndefined();
    expect(refusedNew.rejected.every((item) => item.kind === "new-file-below-global")).toBe(true);

    const written = buildBaseline(summary, previous, { globalThresholds: CONFIG_THRESHOLDS, allowLower: true });
    expect(written.baseline).toBeDefined();
    expect(written.baseline?.version).toBe(BASELINE_VERSION);
    expect(written.baseline?.tolerancePp).toBe(DEFAULT_TOLERANCE_PP);
    expect(Object.keys(written.baseline?.files ?? {})).toEqual(["packages/a/src/new.ts", "packages/a/src/x.ts"]);
    expect(written.baseline?.globalThresholds).toEqual(CONFIG_THRESHOLDS);
    // 过期记录（gone.ts）自动清理；写入结果与文件顺序稳定（可重复）。
    expect(Object.hasOwn(written.baseline?.files ?? {}, "packages/a/src/gone.ts")).toBe(false);
  });

  it("工具函数与接线自检：百分比规范化、路径相对化、命令已接入（防判据空转）", () => {
    expect(normalizePct(84.984)).toBe(84.98);
    expect(normalizePct(84.986)).toBe(84.99);
    expect(normalizePct(undefined)).toBe(0);
    expect(repoRelativePath(join(ROOT, "packages/a/src/x.ts"))).toBe("packages/a/src/x.ts");
    expect(repoRelativePath("/outside/repo/x.ts")).toBeUndefined();

    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["test:coverage"]).toContain("vitest run --coverage");
    expect(manifest.scripts["test:coverage"]).toContain("coverage-ratchet.mjs");
    expect(manifest.scripts["coverage:ratchet"]).toContain("coverage-ratchet.mjs");

    // 棘轮依赖 json-summary reporter；被删掉后脚本会读不到覆盖率汇总。
    const configText = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(configText).toContain('"json-summary"');
    expect(BASELINE_PATH.endsWith(join("scripts", "coverage-baseline.json"))).toBe(true);
  });
});
