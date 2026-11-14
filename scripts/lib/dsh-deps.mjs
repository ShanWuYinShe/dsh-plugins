// scripts/lib/dsh-deps.mjs — dsh 依赖基线提取的共享实现。
// 消费方：scripts/dsh-baseline.mjs（发布 tag，严格模式：非法输入 exit 1）、
//         scripts/dsh-follow-status.mjs（状态核对，容忍模式：打标记继续）。
// 错误策略由调用方决定——本模块只负责读取与解析，不做任何 exit/log 决策。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// engines.dsh 兼容声明的形态判定（精确 / 同线兼容范围 / 非法）与发布包口径
// 校验，与 adapt-dsh / dsh-baseline / dsh-follow-status / 索引生成器同源，
// 见 engines-compat.mjs（策略单一事实源，勿在调用方重写判定）。
import { enginesDshKind, enginesDshProblems } from "./engines-compat.mjs";
import { compareVersions } from "./version-checks.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEP_PREFIX = "@deepseek-ai/dsh-";
export const DEP_SECTIONS = ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"];

/** 仓库内全部 package.json 路径（根 + packages/*，与 build.mjs 的包枚举同源；
 *  包移除后的残留目录无 package.json，跳过以免下游 readFileSync ENOENT）。 */
export function manifestPaths(root = ROOT) {
  return [
    "package.json",
    ...readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((p) => existsSync(join(root, p))),
  ];
}

/** 解析 `^<版本>` 形态的 range；返回版本号或 null（形态不符）。 */
export function baselineOf(range) {
  const m = /^\^([0-9][^\s]*)$/.exec(range);
  return m === null ? null : m[1];
}

/**
 * 扫描一个 package.json 对象：收集全部 dsh-* 依赖的 range 基线（仍是 `^<版本>`）
 * 与 `engines.dsh` 兼容声明（DSH 官方字段，见 @deepseek-ai/dsh-package-manifest
 * 的 DshEnginesManifest）。
 *
 * engines.dsh 接受两种合法形态（判据见 engines-compat.mjs）：
 *   - **精确宿主版本**（如 `0.2.2-rc.3`，有破坏性变更时的保守写法）；
 *   - **同线兼容范围**（严格形态 `>=<下界> <下一线>-0`，如
 *     `>=0.2.2-rc.2 <0.2.3-0`，表示「这些同线宿主版本都能跑」）。
 * 其余宽松范围（`^X` / `~X` / 单界 `>=X` / `*` / `||` 组合等）过度声明
 * 兼容性，一律计入 invalid。
 *
 * 旧字段 `dsh.host` 已废弃且不在官方 manifest 契约内，出现即计入 invalid——
 * 严格模式（dsh-baseline）据此把残留挡在发布前。
 * @returns {{ baselines: string[], enginesDsh: string[], invalid: Array<{section, name, range}> }}
 */
export function scanManifest(manifest) {
  const baselines = new Set();
  const enginesDsh = new Set();
  const invalid = [];
  for (const section of DEP_SECTIONS) {
    const deps = manifest[section];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith(DEP_PREFIX)) continue;
      const version = baselineOf(range);
      if (version === null) invalid.push({ section, name, range });
      else baselines.add(version);
    }
  }
  const engines = manifest.engines;
  if (engines !== null && typeof engines === "object" && Object.hasOwn(engines, "dsh")) {
    const declared = engines.dsh;
    const kind = enginesDshKind(declared);
    if (kind === "invalid") invalid.push({ section: "engines", name: "dsh", range: declared });
    else enginesDsh.add(declared.trim());
  }
  if (manifest.dsh !== null && typeof manifest.dsh === "object" && Object.hasOwn(manifest.dsh, "host")) {
    invalid.push({ section: "dsh", name: "host", range: manifest.dsh.host });
  }
  return { baselines: [...baselines], enginesDsh: [...enginesDsh], invalid };
}

/**
 * 校验一个 manifest 的 engines.dsh 兼容声明相对构建基线是否自洽（空数组 = 通过）。
 *
 * 与 scanManifest 的形态校验互补：这里校验「声明值是否对得上依赖基线」。
 *  - private 清单（根 package.json，全仓唯一「当前对着哪个宿主构建」的事实源）
 *    **必须精确等于基线**——兼容范围也算问题（否则「构建基线」失去唯一锚点）；
 *  - 发布包（非 private）接受精确基线，或覆盖基线的同线兼容范围
 *    （判据见 engines-compat.mjs 的 enginesDshProblems）。
 * 文案不含路径（调用方按需加 `<path>:` 前缀）。
 * @param {Record<string, unknown>} manifest - 解析后的 package.json 对象。
 * @param {string} baseline - 依赖基线（全部 dsh-* range 的 ^ 锚点）。
 * @returns {string[]} 人读问题文案；无问题时为空数组。
 */
export function enginesProblems(manifest, baseline) {
  const engines = manifest?.engines;
  const declared = engines !== null && typeof engines === "object" && Object.hasOwn(engines, "dsh")
    ? engines.dsh
    : undefined;
  if (manifest?.private === true) {
    if (declared === undefined) {
      return [`private 清单缺少 engines.dsh 兼容声明（根必须精确写构建基线 ${baseline}）`];
    }
    const kind = enginesDshKind(declared);
    if (kind === "invalid") {
      return [`private 清单的 engines.dsh 形态非法：${JSON.stringify(declared)}（根必须精确写构建基线 ${baseline}）`];
    }
    if (kind === "compat") {
      return [`private 清单的 engines.dsh 不能写兼容范围：${declared.trim()}（根必须精确写构建基线 ${baseline}）`];
    }
    if (compareVersions(declared.trim(), baseline) !== 0) {
      return [`private 清单的 engines.dsh ${declared.trim()} 与依赖基线 ${baseline} 不一致（根必须精确等于构建基线）`];
    }
    return [];
  }
  return enginesDshProblems(declared, baseline);
}

/**
 * 聚合一个「分支」的全部 package.json。reader(path) 由调用方提供（本地
 * readFileSync 或 `git show <ref>:<path>`），返回解析后的 manifest 对象。
 * @param paths 参与聚合的 manifest 路径，默认磁盘枚举（manifestPaths）。
 *   跨分支读取时由调用方传入该分支的实际路径清单（如 `git ls-tree` 枚举
 *   结果）——磁盘清单属于当前检出的分支，直接拿去 git show 另一分支会因
 *   单侧独有的包而整侧读取失败。
 * @returns {{ baseline: string, enginesDsh: string|undefined, invalid: number }}
 *   baseline 为全仓共同依赖基线；enginesDsh 为**发布包**共同兼容声明（根
 *   private 的精确基线不参与聚合——发布包可能是范围，与根精确值永远不一致）；
 *   任一不一致时对应值给出 `[不一致...]` 标记。
 */
export function aggregateBaseline(reader, root = ROOT, paths = manifestPaths(root)) {
  const all = new Set();
  const enginesDshValues = new Set();
  let invalidCount = 0;
  for (const path of paths) {
    const manifest = reader(path);
    const { baselines, enginesDsh, invalid } = scanManifest(manifest);
    for (const b of baselines) all.add(b);
    // 兼容声明只聚合发布包：根 private 写的是精确构建基线，属于「我们对着哪个
    // 宿主构建」的唯一事实源，混进发布包的范围聚合里会永远不一致。
    if (manifest?.private !== true) {
      for (const h of enginesDsh) enginesDshValues.add(h);
    }
    invalidCount += invalid.length;
  }
  const baseline = all.size > 1 ? `[不一致: ${[...all].join(" / ")}]` : [...all][0] ?? "(无 dsh 依赖)";
  const enginesDsh = enginesDshValues.size > 1 ? "[不一致]" : [...enginesDshValues][0];
  return { baseline, enginesDsh, invalid: invalidCount > 0 ? invalidCount : 0 };
}
