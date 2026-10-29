// scripts/lib/dsh-deps.mjs — dsh 依赖基线提取的共享实现。
// 消费方：scripts/dsh-baseline.mjs（发布 tag，严格模式：非法输入 exit 1）、
//         scripts/dsh-follow-status.mjs（状态核对，容忍模式：打标记继续）。
// 错误策略由调用方决定——本模块只负责读取与解析，不做任何 exit/log 决策。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * 扫描一个 package.json 对象：收集全部 dsh-* 依赖的 range 基线与
 * `engines.dsh` 兼容声明（DSH 官方字段，见 @deepseek-ai/dsh-package-manifest
 * 的 DshEnginesManifest）。
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
    const range = engines.dsh;
    const version = typeof range === "string" ? baselineOf(range) : null;
    if (version === null) invalid.push({ section: "engines", name: "dsh", range });
    else enginesDsh.add(version);
  }
  if (manifest.dsh !== null && typeof manifest.dsh === "object" && Object.hasOwn(manifest.dsh, "host")) {
    invalid.push({ section: "dsh", name: "host", range: manifest.dsh.host });
  }
  return { baselines: [...baselines], enginesDsh: [...enginesDsh], invalid };
}

/**
 * 聚合一个「分支」的全部 package.json。reader(path) 由调用方提供（本地
 * readFileSync 或 `git show <ref>:<path>`），返回解析后的 manifest 对象。
 * @param paths 参与聚合的 manifest 路径，默认磁盘枚举（manifestPaths）。
 *   跨分支读取时由调用方传入该分支的实际路径清单（如 `git ls-tree` 枚举
 *   结果）——磁盘清单属于当前检出的分支，直接拿去 git show 另一分支会因
 *   单侧独有的包而整侧读取失败。
 * @returns {{ baseline: string, enginesDsh: string|undefined, invalid: number }}
 *   baseline 为全仓共同依赖基线；enginesDsh 为全仓共同兼容声明基线；
 *   任一不一致时对应值给出 `[不一致...]` 标记。
 */
export function aggregateBaseline(reader, root = ROOT, paths = manifestPaths(root)) {
  const all = new Set();
  const enginesDshValues = new Set();
  let invalidCount = 0;
  for (const path of paths) {
    const { baselines, enginesDsh, invalid } = scanManifest(reader(path));
    for (const b of baselines) all.add(b);
    for (const h of enginesDsh) enginesDshValues.add(h);
    invalidCount += invalid.length;
  }
  const baseline = all.size > 1 ? `[不一致: ${[...all].join(" / ")}]` : [...all][0] ?? "(无 dsh 依赖)";
  const enginesDsh = enginesDshValues.size > 1 ? "[不一致]" : [...enginesDshValues][0];
  return { baseline, enginesDsh, invalid: invalidCount > 0 ? invalidCount : 0 };
}
