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
 * 扫描一个 package.json 对象：收集全部 dsh-* 依赖的 range 基线与 dsh.host
 * 适配声明。
 * @returns {{ baselines: string[], hosts: string[], invalid: Array<{section, name, range}> }}
 */
export function scanManifest(manifest) {
  const baselines = new Set();
  const hosts = new Set();
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
  if (typeof manifest.dsh?.host === "string" && manifest.dsh.host !== "") hosts.add(manifest.dsh.host);
  return { baselines: [...baselines], hosts: [...hosts], invalid };
}

/**
 * 聚合一个「分支」的全部 package.json。reader(path) 由调用方提供（本地
 * readFileSync 或 `git show <ref>:<path>`），返回解析后的 manifest 对象。
 * @param paths 参与聚合的 manifest 路径，默认磁盘枚举（manifestPaths）。
 *   跨分支读取时由调用方传入该分支的实际路径清单（如 `git ls-tree` 枚举
 *   结果）——磁盘清单属于当前检出的分支，直接拿去 git show 另一分支会因
 *   单侧独有的包而整侧读取失败。
 * @returns {{ baseline: string, host: string|undefined, invalid: number }}
 *   baseline 为全仓共同基线；不一致时为 `[不一致: ...]` 标记（host 同理）。
 */
export function aggregateBaseline(reader, root = ROOT, paths = manifestPaths(root)) {
  const all = new Set();
  const hosts = new Set();
  let invalidCount = 0;
  for (const path of paths) {
    const { baselines, hosts: manifestHosts, invalid } = scanManifest(reader(path));
    for (const b of baselines) all.add(b);
    for (const h of manifestHosts) hosts.add(h);
    invalidCount += invalid.length;
  }
  const baseline = all.size > 1 ? `[不一致: ${[...all].join(" / ")}]` : [...all][0] ?? "(无 dsh 依赖)";
  const host = hosts.size > 1 ? "[不一致]" : [...hosts][0];
  return { baseline, host, invalid: invalidCount > 0 ? invalidCount : 0 };
}
