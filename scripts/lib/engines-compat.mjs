// scripts/lib/engines-compat.mjs — engines.dsh 兼容声明的形态解析与发布期校验。
//
// 消费方：scripts/adapt-dsh.mjs（写兼容声明）、scripts/dsh-baseline.mjs（发布门禁，
// 严格模式）、scripts/dsh-follow-status.mjs（状态核对）、scripts/lib/dsh-deps.mjs
// （scanManifest/enginesProblems）、scripts/lib/plugin-market-core.mjs（索引收录）。
// 提取为单一来源的原因：这些消费方以前各自手写"精确 pin"判定，策略切换时必然漂移。
//
// 策略（RELEASING.md「兼容声明与 engines.dsh」）：
//  - 发布包 engines.dsh 可写**精确构建基线**（有破坏性变更时）或**同线兼容范围**
//    ">=<下界> <下一线>-0"（无破坏性变更、且已验证旧宿主可跑时）；
//  - 根 package.json（private）engines.dsh 永远写精确构建基线，作为"当前对着哪个宿主
//    构建"的唯一事实源；
//  - 上界必须是 "<下一线>-0"，不能写 "<下一线>"：宿主判定用
//    semver.satisfies(runtimeVersion, range, { includePrerelease: true })
//    （dsh-app-boot 的 plugin-compatibility 实现），"<0.2.3" 会放过
//    "0.2.3-alpha.0"，只有 "<0.2.3-0"（数字标识符 0 小于任何 alpha/rc）能挡住下一线
//    的全部预发布。
//
// 错误策略由调用方决定——本模块只做纯判定与格式化，不做 exit/log 决策。

import { compareVersions, parseVersion, VERSION_RE } from "./version-checks.mjs";

/**
 * 兼容范围形态：" >=<下界> <下一线>-0 "（去空白后严格匹配）。
 * 刻意只接受这一种严格形态（两个比较符、上界固定 "-0"）：
 *  - 宽松形态（^X / ~X / * / || 组合）会过度声明兼容性，且历史 tarball 的
 *    单界范围还要继续按"下界 pin"解释（见 plugin-market-core 的 rangeSource=floor）；
 *  - 上界写死 "-0" 才能与宿主 includePrerelease 判定口径一致。
 */
const COMPAT_RANGE_RE = /^>=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+<\s*(\d+\.\d+\.\d+)-0$/;

/**
 * 语义化版本的"下一线"基础号：DSH 每条宿主线是完整 X.Y.Z 基础号（0.2.1 → 0.2.2），
 * 下一线 = 补丁号 +1（0.2.2-rc.3 → 0.2.3）。不处理 major/minor 进位：DSH 至今未用。
 * @param {string} version - 合法 semver。
 * @returns {string} 下一线基础号（如 "0.2.3"）。
 */
export function nextLineOf(version) {
  const parsed = parseVersion(version);
  return parsed.maj + "." + parsed.min + "." + (parsed.pat + 1);
}

/**
 * 生成发布包兼容范围：下界 floor，上界固定为构建基线版本的下一线 "-0"。
 * @param {string} version - 构建基线（精确宿主版本，如 0.2.2-rc.3）。
 * @param {string} floor - 兼容下界（同基础号、<= version）。
 * @returns {string} 形如 ">=0.2.2-rc.2 <0.2.3-0"。
 * @throws {Error} 入参不是合法 semver（调用方已校验，这里防御误用）。
 */
export function formatCompatRange(version, floor) {
  if (!VERSION_RE.test(String(version))) throw new Error("formatCompatRange: 构建基线不是合法 semver: " + String(version));
  if (!VERSION_RE.test(String(floor))) throw new Error("formatCompatRange: 兼容下界不是合法 semver: " + String(floor));
  return ">=" + floor + " <" + nextLineOf(version) + "-0";
}

/**
 * 解析严格形态的兼容范围。
 * @param {unknown} declared - engines.dsh 的原始声明值。
 * @returns {{ floor: string, nextLine: string } | undefined} 形态不符返回 undefined。
 */
export function parseCompatRange(declared) {
  if (typeof declared !== "string") return undefined;
  const match = COMPAT_RANGE_RE.exec(declared.trim());
  if (match === null) return undefined;
  return { floor: match[1], nextLine: match[2] };
}

/**
 * engines.dsh 声明形态分类。
 * @param {unknown} declared - engines.dsh 的原始声明值。
 * @returns {"exact" | "compat" | "invalid"}
 */
export function enginesDshKind(declared) {
  if (typeof declared !== "string") return "invalid";
  const text = declared.trim();
  if (VERSION_RE.test(text)) return "exact";
  return parseCompatRange(text) === undefined ? "invalid" : "compat";
}

/**
 * 发布包 engines.dsh 相对构建基线的问题清单（空数组 = 通过）。根 private 清单的
 * "必须精确等于基线"由调用方（dsh-baseline/dsh-deps）单独判定，本函数按发布包口径校验。
 * @param {unknown} declared - engines.dsh 的原始声明值。
 * @param {string} baseline - 依赖基线（全部 dsh-* range 的 ^ 锚点，证明构建/测试针对的宿主版本）。
 * @returns {string[]} 人读问题文案；无问题时为空数组。
 */
export function enginesDshProblems(declared, baseline) {
  if (declared === undefined) {
    return ["缺少 engines.dsh 兼容声明（官方 manifest 字段；发布包写精确基线或同线兼容范围）"];
  }
  const kind = enginesDshKind(declared);
  if (kind === "invalid") {
    return [
      "engines.dsh 形态非法：" + JSON.stringify(declared)
        + "——只能是精确宿主版本（如 " + baseline + "）或同线兼容范围（如 "
        + formatCompatRange(baseline, baseline) + "）",
    ];
  }
  const text = declared.trim();
  if (kind === "exact") {
    // compareVersions 忽略 build metadata（semver 口径），精确声明必须落在构建基线上。
    if (compareVersions(text, baseline) !== 0) {
      return ["engines.dsh 精确声明 " + text + " 与依赖基线 " + baseline + " 不一致——无向后兼容时精确声明必须等于构建基线"];
    }
    return [];
  }
  const range = parseCompatRange(text);
  const problems = [];
  const expectedNextLine = nextLineOf(baseline);
  if (range.nextLine !== expectedNextLine) {
    problems.push(
      "兼容范围上界必须切在构建基线的下一线（" + baseline + " 期望 <" + expectedNextLine + "-0，实际 <" + range.nextLine + "-0）"
        + "——宿主按 includePrerelease 判定，写 <" + range.nextLine + " 会放过下一线预发布",
    );
  }
  const floorCore = parseVersion(range.floor);
  const baselineCore = parseVersion(baseline);
  if (floorCore.maj !== baselineCore.maj || floorCore.min !== baselineCore.min || floorCore.pat !== baselineCore.pat) {
    problems.push(
      "兼容范围下界 " + range.floor + " 与构建基线 " + baseline + " 不在同一宿主基础号"
        + "——当前策略只支持同线向后兼容（跨线兼容需另行评估，不写范围）",
    );
  } else if (compareVersions(range.floor, baseline) > 0) {
    problems.push("兼容范围下界 " + range.floor + " 高于构建基线 " + baseline + "——范围不包含构建基线本身");
  }
  return problems;
}
