// DSH 宿主升级适配：一条命令改齐所有 `@deepseek-ai/dsh-*` 依赖 range
// 的版本号，并同步 engines.dsh 兼容声明。
// 用法：node scripts/adapt-dsh.mjs <新宿主版本> [--compat <下界>] [--dry-run]
//   例：node scripts/adapt-dsh.mjs 0.2.2-rc.3
//       node scripts/adapt-dsh.mjs 0.2.2-rc.3 --compat 0.2.2-rc.2
//
// 覆盖范围：根 package.json 与 packages/*/package.json 的 dependencies /
// optionalDependencies / devDependencies / peerDependencies，以及 engines.dsh
// 兼容声明（官方 manifest 字段，形态/语义判据与发布门禁同源，见
// lib/engines-compat.mjs）：
//   - 根 package.json（private）永远写**精确构建基线** `<版本>`——全仓唯一
//     「当前对着哪个宿主构建」的事实源；
//   - 发布包默认写**精确** `<版本>`（保守：宿主升级很可能不兼容旧版本）；
//     传 `--compat <下界>` 则写**同线兼容范围** `>=<下界> <下一线>-0`，表示
//     已核对旧宿主仍可运行（下界必须与版本同基础号且 <= 版本）。
// 同时删除废弃的旧字段 dsh.host。@deepseek-ai/cordis、schemastery 等非 dsh-*
// 包不在范围内（独立版本线，另行手工升级）。
//
// 脚本不做的事（按 RELEASING.md 手工完成）：
//   - 升各包版本号、写 CHANGELOG（发布决策）
//   - bun install 重新生成 lockfile（需要网络）

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
// dsh 依赖口径与包枚举统一取自 lib/dsh-deps.mjs（与 publish-gate /
// dsh-follow-status / dsh-baseline 同源），避免四份实现各自漂移。
import { DEP_PREFIX, DEP_SECTIONS, manifestPaths, ROOT } from "./lib/dsh-deps.mjs";
// 兼容范围的格式化与回环校验（与 dsh-baseline / dsh-follow-status 同一判据来源）。
import { formatCompatRange, parseCompatRange } from "./lib/engines-compat.mjs";
// 与 publish-gate / dsh-follow-status 同一口径的 semver 校验（共享单一来源，见 issue #6）。
import { VERSION_RE, compareVersions, parseVersion } from "./lib/version-checks.mjs";

const USAGE = "用法: node scripts/adapt-dsh.mjs <版本> [--compat <下界>] [--dry-run]    例: node scripts/adapt-dsh.mjs 0.2.2-rc.3 --compat 0.2.2-rc.2";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
// --compat <下界>：发布包写同线兼容范围而非精确版本（根仍写精确基线）。
let compatFloor;
let compatSeen = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--dry-run") continue;
  if (arg === "--compat" || arg.startsWith("--compat=")) {
    compatSeen = true;
    compatFloor = arg === "--compat" ? args[++i] : arg.slice("--compat=".length);
    continue;
  }
  if (arg.startsWith("--")) {
    console.error(USAGE);
    process.exit(2);
  }
  positional.push(arg);
}
const version = positional[0];
// 合法 semver（含 prerelease / build metadata），与 publish-gate 的
// VERSION_RE 同口径。此前 ^[\w.]+$ 过松：接受下划线/大写/前导零等非法
// 形态，一旦放行会把 5 个 manifest 的 dsh-* range 整块覆写成 npm 无法
// 解析的 range，直到 bun install 才爆。
if (positional.length !== 1 || !version || !VERSION_RE.test(version)) {
  console.error(USAGE);
  process.exit(2);
}
if (compatSeen) {
  if (compatFloor === undefined || !VERSION_RE.test(compatFloor)) {
    console.error("--compat 的兼容下界必须是合法 semver。\n" + USAGE);
    process.exit(2);
  }
  // 当前策略只支持同一宿主基础号内的向后兼容（跨线兼容另行评估）：
  // 下界必须与构建基线同基础号且不高于它，否则范围不覆盖基线本身。
  const floorCore = parseVersion(compatFloor);
  const baseCore = parseVersion(version);
  if (floorCore.maj !== baseCore.maj || floorCore.min !== baseCore.min || floorCore.pat !== baseCore.pat) {
    console.error(`--compat 下界 ${compatFloor} 与宿主版本 ${version} 不在同一宿主基础号（当前只支持同线兼容）。\n` + USAGE);
    process.exit(2);
  }
  if (compareVersions(compatFloor, version) > 0) {
    console.error(`--compat 下界 ${compatFloor} 高于宿主版本 ${version}——兼容范围必须覆盖构建基线本身。\n` + USAGE);
    process.exit(2);
  }
}
// 发布包的兼容声明（根 private 不用它：根永远精确构建基线）。VERSION_RE 允许
// build metadata，但严格兼容范围不支持（下界必须与声明形态完全一致），回环
// 校验一次：宁可 exit 2 也不写出 dsh-baseline 会拒绝的声明。
const packageEngines = compatFloor === undefined ? version : formatCompatRange(version, compatFloor);
if (compatFloor !== undefined && parseCompatRange(packageEngines) === undefined) {
  console.error(`--compat 下界 ${compatFloor} 不能带 build metadata（兼容范围只接受严格 semver 下界）。\n` + USAGE);
  process.exit(2);
}

function adaptPackageJson(path) {
  const rel = relative(ROOT, path);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const changes = [];
  for (const section of DEP_SECTIONS) {
    const deps = json[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith(DEP_PREFIX) && deps[name] !== `^${version}`) {
        changes.push([section, name, deps[name], `^${version}`]);
        deps[name] = `^${version}`;
      }
    }
  }
  // engines.dsh 兼容声明（DSH 官方 manifest 字段：安装与 profile 启动据此
  // 判定兼容性，宿主按 SemVer range + includePrerelease 判定）。根（private）
  // 写精确构建基线作为唯一事实源；发布包写出 packageEngines（精确或兼容范围）。
  // 发布包至少有一条 dsh-* 依赖才补 engines 对象；根没有 dsh 依赖也要写，
  // 否则 dsh-baseline 找不到构建基线。
  const hasDshDep = DEP_SECTIONS.some((section) => {
    const deps = json[section];
    return deps !== null && typeof deps === "object" && Object.keys(deps).some((name) => name.startsWith(DEP_PREFIX));
  });
  let engines = json.engines !== null && typeof json.engines === "object" ? json.engines : undefined;
  if (engines === undefined && (json.private === true || hasDshDep)) {
    engines = json.engines = {};
  }
  if (engines !== undefined) {
    const desired = json.private === true ? version : packageEngines;
    if (engines.dsh !== desired) {
      changes.push(["engines", "dsh", engines.dsh ?? "(缺省)", desired]);
      engines.dsh = desired;
    }
  }
  // 旧字段 dsh.host 已废弃（不在官方 DshManifest 契约内），出现即删除。
  if (json.dsh !== null && typeof json.dsh === "object" && Object.hasOwn(json.dsh, "host")) {
    changes.push(["dsh", "host(已废弃)", json.dsh.host, "(删除)"]);
    delete json.dsh.host;
    if (Object.keys(json.dsh).length === 0) delete json.dsh;
  }
  if (changes.length === 0) return;
  for (const [section, name, from, to] of changes) {
    // 兼容声明行显式标注形态，避免「精确 / 范围」在日志里分不清。
    const form = section === "engines" ? (to.startsWith(">=") ? "（兼容范围）" : "（精确）") : "";
    console.log(`  ${rel} [${section}] ${name}: ${from} → ${to}${form}`);
  }
  if (!dryRun) writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

const mode = compatFloor === undefined
  ? "发布包写精确版本"
  : `发布包写兼容范围，下界 ${compatFloor}`;
console.log(`适配 DSH 宿主 ${version}（${mode}${dryRun ? "；dry-run，不写入" : ""}）:`);
for (const rel of manifestPaths()) {
  adaptPackageJson(join(ROOT, rel));
}

console.log(dryRun ? "\n[dry-run] 未写入任何文件。" : "\n已写入。");
console.log("后续手工步骤（详见 RELEASING.md）:");
console.log("  1. 升相关包 package.json 的 version，并在 CHANGELOG.md 记录本次适配");
console.log("  2. bun install 重新生成 lockfile");
console.log("  3. bun run test:ci 验证后提交推送");
