#!/usr/bin/env node
/**
 * coverage-ratchet.mjs — 逐文件覆盖率棘轮（防回退门禁 + 基线维护）。
 *
 * 背景：官方规则 RULE-088 的门禁口径是 `packages/*\/*\/src` **逐文件 100%**
 * （docs/testing.md「Coverage gate」；未覆盖行往往是死代码，应由门禁提示删除而不是
 * 补测试凑数）。本仓尚未达到逐文件 100%，但可以先锁住**不允许回退**：把当前
 * 每个文件的覆盖率写进版本化基线 `scripts/coverage-baseline.json`，每次
 * `bun run test:coverage` 之后逐文件比对——任何文件不得低于基线（容差 0.2pp，
 * 覆盖工具/环境的极小抖动），高于基线时由 `--write` 手动上调（棘轮只进不退）。
 * 新增文件必须达到**全局阈值**（vitest.config.ts 的 thresholds）才能进入基线；
 * 消失的文件由 `--write` 自动清理。逐文件 100% 仍是长期目标，本脚本只保证
 * “今天不比昨天差”。
 *
 * 用法：
 *   node scripts/coverage-ratchet.mjs            # 校验（bun run test:coverage 的最后一步）
 *   node scripts/coverage-ratchet.mjs --write    # 按当前覆盖率刷新基线（只升不降）
 *   node scripts/coverage-ratchet.mjs --write --lower
 *                                               # 显式放宽：允许写入低于旧基线的值，
 *                                               #   用于「确实删掉了已验证代码」等场景；
 *                                               #   必须在提交信息里说明。CI 不使用。
 *
 * 输入：
 *   coverage/coverage-summary.json  ← vitest.config.ts 的 `reporter: json-summary`
 *   scripts/coverage-baseline.json  ← 版本化基线（本脚本 --write 生成）
 *
 * 退出码：0 通过；1 存在回退/过期记录/新增文件未达阈值；2 输入缺失或无法解析
 * （先跑 build + `vitest run --coverage`）。
 *
 * @module dsh-plugins/scripts/coverage-ratchet
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（scripts/ 的上一级）。 */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 覆盖率汇总文件（vitest json-summary reporter 的产物）。 */
export const SUMMARY_PATH = join(ROOT, 'coverage', 'coverage-summary.json')

/** 版本化基线文件。 */
export const BASELINE_PATH = join(ROOT, 'scripts', 'coverage-baseline.json')

/** 基线文件格式版本；结构变更时 +1 并迁移。 */
export const BASELINE_VERSION = 1

/** 逐文件允许的比较容差（百分点）：只吸收覆盖率采集的极小抖动，不掩盖回退。 */
export const DEFAULT_TOLERANCE_PP = 0.2

/** 参与逐文件棘轮的四个指标（与 vitest thresholds 同名）。 */
export const METRICS = ['statements', 'branches', 'functions', 'lines']

/** vitest.config.ts 里 coverage 面的解析结果。 */
const CONFIG_PATH = join(ROOT, 'vitest.config.ts')

/**
 * 从 vitest.config.ts 文本解析 coverage 的 include / exclude / thresholds。
 *
 * 只解析本仓配置用到的对象字面量子集（数组 + 数字字段）；生产侧单源仍是
 * vitest.config.ts，这里读出来只为让棘轮脚本/锁与配置保持一致，避免两处
 * 手写阈值漂移。解析失败返回 undefined（脚本会明确报错而不是静默放行）。
 *
 * @param configText - vitest.config.ts 的完整文本。
 * @returns `{ include, exclude, thresholds }`，或 undefined。
 */
export function parseCoverageConfig(configText) {
  const coverageAt = configText.indexOf('coverage:')
  if (coverageAt === -1) return undefined
  const coverageText = configText.slice(coverageAt)

  const readStringArray = (key) => {
    const match = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(coverageText)
    if (match === null) return undefined
    return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1])
  }
  const readThresholds = () => {
    const match = /thresholds:\s*\{([\s\S]*?)\}/.exec(coverageText)
    if (match === null) return undefined
    const thresholds = {}
    for (const metric of METRICS) {
      const value = new RegExp(`\\b${metric}:\\s*(\\d+(?:\\.\\d+)?)`).exec(match[1])
      if (value === null) return undefined
      thresholds[metric] = Number(value[1])
    }
    return thresholds
  }

  const include = readStringArray('include')
  const exclude = readStringArray('exclude')
  const thresholds = readThresholds()
  if (include === undefined || exclude === undefined || thresholds === undefined) return undefined
  return { include, exclude, thresholds }
}

/**
 * 读取 vitest.config.ts 的 coverage 配置（CLI --write 时用来补全/刷新阈值）。
 * @returns 解析结果，或 undefined（文件缺失/解析失败）。
 */
export function readCoverageConfig() {
  if (!existsSync(CONFIG_PATH)) return undefined
  return parseCoverageConfig(readFileSync(CONFIG_PATH, 'utf8'))
}

/**
 * 把覆盖率/基线的百分比规范化为 2 位小数（消除浮点尾差，保证基线与比对可重复）。
 * @param value - 原始百分比。
 * @returns 保留 2 位小数的数字。
 */
export function normalizePct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * 把覆盖率汇总里的绝对路径转成仓库相对路径（POSIX 分隔符，跨平台可比对）。
 * @param file - 覆盖率汇总的 key（绝对路径）。
 * @returns 仓库相对路径；不在仓库内时返回 undefined。
 */
export function repoRelativePath(file) {
  const resolved = isAbsolute(file) ? file : resolve(ROOT, file)
  const rel = relative(ROOT, resolved).split(sep).join('/')
  if (rel === '' || rel.startsWith('..')) return undefined
  return rel
}

/**
 * 把 vitest `coverage-summary.json` 转成逐文件基线结构。
 *
 * 只取四个百分比指标；`total` 汇总行与仓库外文件跳过。
 * @param summary - coverage-summary.json 的解析结果。
 * @returns `{ files }`，key 为仓库相对路径，value 为四个百分比。
 */
export function baselineFromSummary(summary) {
  const files = {}
  for (const [file, data] of Object.entries(summary ?? {})) {
    if (file === 'total') continue
    const rel = repoRelativePath(file)
    if (rel === undefined) continue
    const entry = {}
    for (const metric of METRICS) {
      entry[metric] = normalizePct(data?.[metric]?.pct)
    }
    files[rel] = entry
  }
  return { files }
}

/**
 * 校验当前覆盖率是否不低于基线。
 *
 * 规则：
 * 1. 基线里已有的文件：四个指标都不得低于 `baseline - tolerancePp`
 *    （任一指标回退即违规）；
 * 2. 覆盖率面里有、基线里没有的新文件：四个指标都必须达到 `globalThresholds`
 *    （新增源文件不允许带着低覆盖进入基线）；
 * 3. 基线里有、当前覆盖率面里没有的文件：视为过期记录（文件被删或移出 coverage
 *    face），需 `--write` 清理——过期记录留在基线里会掩盖未来的回退。
 *
 * @param summary - coverage-summary.json 的解析结果。
 * @param baseline - 版本化基线对象（含 files / globalThresholds / tolerancePp）。
 * @returns 违规明细与统计，供 CLI 打印与测试断言。
 */
export function evaluateCoverage(summary, baseline) {
  const current = baselineFromSummary(summary).files
  const expected = baseline?.files ?? {}
  const tolerance = typeof baseline?.tolerancePp === 'number' ? baseline.tolerancePp : DEFAULT_TOLERANCE_PP
  const globalThresholds = baseline?.globalThresholds ?? {}
  const violations = []
  const newFiles = []
  const improvedFiles = []
  const stale = Object.keys(expected).filter((file) => current[file] === undefined).sort()

  for (const [file, actual] of Object.entries(current)) {
    const floorEntry = expected[file]
    if (floorEntry === undefined) {
      newFiles.push(file)
      for (const metric of METRICS) {
        const required = normalizePct(globalThresholds[metric] ?? 0)
        if (actual[metric] < required) {
          violations.push({ file, metric, actual: actual[metric], required, kind: 'new-file-below-global' })
        }
      }
      continue
    }
    let improved = false
    for (const metric of METRICS) {
      const floor = normalizePct(floorEntry[metric])
      const allowedFloor = Math.round((floor - tolerance) * 100) / 100
      if (actual[metric] < allowedFloor) {
        violations.push({
          file,
          metric,
          actual: actual[metric],
          required: floor,
          allowedFloor,
          kind: 'below-baseline',
        })
      } else if (actual[metric] > floor) {
        improved = true
      }
    }
    if (improved) improvedFiles.push(file)
  }

  return {
    violations,
    stale,
    newFiles: newFiles.sort(),
    improvedFiles: improvedFiles.sort(),
    checkedFiles: Object.keys(current).length,
    tolerance,
  }
}

/**
 * 把当前覆盖率写成新的基线（棘轮只升不降；需要放宽时传 allowLower）。
 *
 * - 已存在文件的新值低于旧基线超过容差的，视为「放宽」，默认拒绝写入并列出；
 *   传 `allowLower` 才写入（提交信息必须说明原因）；
 * - 新增文件低于全局阈值的，同样默认拒绝（先补测试）；
 * - 过期记录自动清理（写入只包含当前覆盖率面）。
 *
 * @param summary - coverage-summary.json 的解析结果。
 * @param previous - 旧基线（可为空）。
 * @param options - `{ globalThresholds, allowLower, tolerancePp }`。
 * @returns `{ baseline, lowerings, rejected }`；`rejected` 非空表示未写入。
 */
export function buildBaseline(summary, previous, options = {}) {
  const tolerancePp = options.tolerancePp ?? DEFAULT_TOLERANCE_PP
  const globalThresholds = options.globalThresholds ?? previous?.globalThresholds ?? {}
  const allowLower = options.allowLower === true
  const current = baselineFromSummary(summary).files
  const previousFiles = previous?.files ?? {}
  const lowerings = []
  const rejected = []
  // 首次建立基线（没有 previous）是**引导**：记录当前现状，不套全局阈值——
  // 否则任何历史遗留的低覆盖文件都写不进去，基线永远建不起来。从第二次
  // --write 起，「新增文件」才必须达到全局阈值。
  const bootstrap = previous === undefined

  for (const [file, actual] of Object.entries(current)) {
    const floorEntry = previousFiles[file]
    for (const metric of METRICS) {
      const value = actual[metric]
      if (floorEntry === undefined) {
        // 新增文件（基线已存在时）：必须达到全局阈值（显式 --lower 才允许例外）。
        const required = normalizePct(globalThresholds[metric] ?? 0)
        if (!bootstrap && value < required && !allowLower) {
          rejected.push({ file, metric, actual: value, required, kind: 'new-file-below-global' })
        }
        continue
      }
      const floor = normalizePct(floorEntry[metric])
      if (value < Math.round((floor - tolerancePp) * 100) / 100) {
        lowerings.push({ file, metric, from: floor, to: value })
      }
    }
  }

  if (rejected.length > 0) return { baseline: undefined, lowerings, rejected }
  if (lowerings.length > 0 && !allowLower) return { baseline: undefined, lowerings, rejected }

  const files = {}
  for (const [file, actual] of Object.entries(current)) {
    files[file] = actual
  }
  return {
    baseline: {
      version: BASELINE_VERSION,
      tolerancePp,
      globalThresholds,
      files: Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file]])),
    },
    lowerings,
    rejected,
  }
}

/** 读取 JSON 文件；不存在返回 undefined。 */
function readJson(file) {
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 打印一行错误并返回是否继续的约定由调用方决定。 */
function line(text) {
  process.stderr.write(`${text}\n`)
}

/**
 * CLI 主流程。
 * @param argv - 命令行参数（不含 node/脚本路径）。
 * @returns 退出码。
 */
export function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write')
  const allowLower = argv.includes('--lower')
  if (argv.includes('--help') || argv.includes('-h')) {
    line('用法: node scripts/coverage-ratchet.mjs [--write [--lower]]')
    return 0
  }

  const summary = readJson(SUMMARY_PATH)
  if (summary === undefined) {
    line(`coverage:ratchet: 缺少 ${relative(ROOT, SUMMARY_PATH)} —— 先运行 bun run test:coverage（或 node scripts/build.mjs && npx vitest run --coverage）。`)
    return 2
  }

  if (write) {
    const previous = readJson(BASELINE_PATH)
    // 阈值以 vitest.config.ts 为单源：每次 --write 都刷新基线里的镜像值，
    // 防止配置上调阈值后基线仍记录旧阈值（新增文件会被旧阈值放行）。
    const config = readCoverageConfig()
    if (config === undefined) {
      line('coverage:ratchet: 无法从 vitest.config.ts 解析 coverage.include/exclude/thresholds，拒绝写基线。')
      return 2
    }
    const { baseline, lowerings, rejected } = buildBaseline(summary, previous, {
      globalThresholds: config.thresholds,
      allowLower,
      tolerancePp: previous?.tolerancePp ?? DEFAULT_TOLERANCE_PP,
    })
    if (rejected.length > 0) {
      line('coverage:ratchet: 拒绝写入基线——以下新增文件未达到全局阈值（先补测试；确认是死代码就删掉）：')
      for (const item of rejected) {
        line(`  ✗ ${item.file}: ${item.metric} ${item.actual}% < 全局阈值 ${item.required}%`)
      }
      return 1
    }
    if (baseline === undefined) {
      line(`coverage:ratchet: 拒绝写入基线——以下文件低于旧基线超过容差 ${(previous?.tolerancePp ?? DEFAULT_TOLERANCE_PP)}pp：`)
      for (const item of lowerings) line(`  ↓ ${item.file}: ${item.metric} ${item.from}% → ${item.to}%`)
      line('如确属删除了已验证代码/重构导致的下降，确认后运行 `bun run coverage:ratchet --write --lower` 显式放宽，并在提交信息说明。')
      return 1
    }
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
    const previousFiles = previous?.files ?? {}
    const added = Object.keys(baseline.files).filter((file) => previousFiles[file] === undefined)
    const removed = Object.keys(previousFiles).filter((file) => baseline.files[file] === undefined)
    line(`coverage:ratchet: 已写入基线 ${relative(ROOT, BASELINE_PATH)}（${Object.keys(baseline.files).length} 个文件；新增 ${added.length}，清理 ${removed.length}，显式放宽 ${lowerings.length}）`)
    for (const file of removed) line(`  - 已清理: ${file}`)
    return 0
  }

  const baseline = readJson(BASELINE_PATH)
  if (baseline === undefined) {
    line(`coverage:ratchet: 缺少 ${relative(ROOT, BASELINE_PATH)} —— 先运行 bun run coverage:ratchet --write 生成基线。`)
    return 2
  }
  const result = evaluateCoverage(summary, baseline)
  if (result.stale.length > 0) {
    line('coverage:ratchet: 基线里有过期记录（文件已删除或不再纳入 coverage）——确认后运行 `bun run coverage:ratchet --write` 清理：')
    for (const file of result.stale) line(`  ✗ ${file}`)
  }
  if (result.violations.length > 0) {
    line(`coverage:ratchet: ${result.violations.length} 项覆盖率回退（容差 ${result.tolerance}pp）：`)
    for (const item of result.violations) {
      if (item.kind === 'new-file-below-global') {
        line(`  ✗ ${item.file}: ${item.metric} ${item.actual}% < 全局阈值 ${item.required}%（新增文件必须达到全局阈值）`)
      } else {
        line(`  ✗ ${item.file}: ${item.metric} ${item.actual}% < 基线 ${item.required}%（容差 ${result.tolerance}pp，允许下限 ${item.allowedFloor}%）`)
      }
    }
    line('处理：补测试把覆盖率拉回基线；确认代码已删除/重构导致的可接受下降，才用 `bun run coverage:ratchet --write --lower` 显式放宽（提交信息说明）。')
  }
  if (result.stale.length > 0 || result.violations.length > 0) return 1
  line(
    `coverage:ratchet: OK — ${result.checkedFiles} 个文件全部不低于基线（容差 ${result.tolerance}pp；`
      + `新增 ${result.newFiles.length}、提升 ${result.improvedFiles.length}，可运行 \`bun run coverage:ratchet --write\` 上调基线）。`,
  )
  return 0
}

/**
 * 判断本模块是否被当作入口直接执行（测试 import 复用纯函数时不跑 CLI）。
 * @returns 直接执行时为 true。
 */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2))
}
