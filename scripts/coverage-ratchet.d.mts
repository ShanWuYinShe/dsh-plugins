/**
 * coverage-ratchet.mjs 的类型声明。
 *
 * 该模块是 .mjs（供 scripts/*.mjs 与根 test 直接 import），仓库 tsconfig 不开 allowJs，
 * 因此 TS 侧（`test/coverage-baseline.test.ts`）需要这份声明——声明与实现的一致性由
 * 该锁的导出面用例钉住（导出缺失会直接 typecheck 失败）。
 */

/** 仓库根目录（scripts/ 的上一级）。 */
export declare const ROOT: string;

/** 覆盖率汇总文件（vitest json-summary reporter 的产物）。 */
export declare const SUMMARY_PATH: string;

/** 版本化基线文件。 */
export declare const BASELINE_PATH: string;

/** 基线文件格式版本；结构变更时 +1 并迁移。 */
export declare const BASELINE_VERSION: number;

/** 逐文件允许的比较容差（百分点）。 */
export declare const DEFAULT_TOLERANCE_PP: number;

/** 参与逐文件棘轮的四个指标。 */
export declare const METRICS: readonly ["statements", "branches", "functions", "lines"];

/** 单个文件的四个百分比指标。 */
export interface FileCoverage {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

/** 覆盖率汇总里单个指标的统计块（vitest json-summary 形态）。 */
export interface SummaryMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

/** 覆盖率汇总（key 为绝对路径，另有 `total` 汇总行）。 */
export type CoverageSummary = Record<string, Record<string, SummaryMetric> | undefined>;

/** 版本化基线文件结构。 */
export interface CoverageBaseline {
  version: number;
  tolerancePp: number;
  globalThresholds: Record<string, number>;
  files: Record<string, FileCoverage>;
}

/** 覆盖率回退项。 */
export interface CoverageViolation {
  file: string;
  metric: string;
  actual: number;
  required: number;
  allowedFloor?: number;
  kind: "below-baseline" | "new-file-below-global";
}

/** `evaluateCoverage` 的校验结果。 */
export interface CoverageEvaluation {
  violations: CoverageViolation[];
  stale: string[];
  newFiles: string[];
  improvedFiles: string[];
  checkedFiles: number;
  tolerance: number;
}

/** 规范化百分比到 2 位小数。 */
export declare function normalizePct(value: unknown): number;

/** 绝对路径 → 仓库相对路径（POSIX）；不在仓库内返回 undefined。 */
export declare function repoRelativePath(file: string): string | undefined;

/** 覆盖率汇总 → `{ files }` 逐文件基线结构。 */
export declare function baselineFromSummary(summary: CoverageSummary): { files: Record<string, FileCoverage> };

/** 校验当前覆盖率是否不低于基线（回退/新增文件/过期记录）。 */
export declare function evaluateCoverage(summary: CoverageSummary, baseline: CoverageBaseline): CoverageEvaluation;

/** 按当前覆盖率生成新基线（默认拒绝放宽；`allowLower` 显式放宽）。 */
export declare function buildBaseline(
  summary: CoverageSummary,
  previous: CoverageBaseline | undefined,
  options?: { globalThresholds?: Record<string, number>; allowLower?: boolean; tolerancePp?: number },
): {
  baseline?: CoverageBaseline;
  lowerings: { file: string; metric: string; from: number; to: number }[];
  rejected: CoverageViolation[];
};

/** 解析 vitest.config.ts 文本中的 coverage.include/exclude/thresholds。 */
export declare function parseCoverageConfig(
  configText: string,
): { include: string[]; exclude: string[]; thresholds: Record<string, number> } | undefined;

/** 读取 vitest.config.ts 的 coverage 配置；文件缺失/解析失败返回 undefined。 */
export declare function readCoverageConfig():
  | { include: string[]; exclude: string[]; thresholds: Record<string, number> }
  | undefined;

/** CLI 主流程（测试可注入 argv；正常由文件底部直接执行）。 */
export declare function main(argv?: string[]): number;
