// DSH 宿主升级适配：一条命令改齐所有 `@deepseek-ai/dsh-*` 依赖 range
// 的版本号。
// 用法：node scripts/adapt-dsh.mjs <新宿主版本> [--dry-run]
//   例：node scripts/adapt-dsh.mjs 0.1.2-alpha.4
//
// 覆盖范围：根 package.json 与 packages/*/package.json 的 dependencies /
// optionalDependencies / devDependencies / peerDependencies，以及发布包的
// engines.dsh 兼容声明（与依赖 range 同形 `^<版本>`，官方 manifest 字段）；
// 同时删除废弃的旧字段 dsh.host。@deepseek-ai/cordis、schemastery 等非 dsh-*
// 包不在范围内（独立版本线，另行手工升级）。
//
// 脚本不做的事（按 RELEASING.md 手工完成）：
//   - 升各包版本号、写 CHANGELOG（发布决策）
//   - bun install 重新生成 lockfile（需要网络）

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
// dsh 依赖口径与包枚举统一取自 lib/dsh-deps.mjs（与 publish-gate /
// dsh-follow-status / dsh-baseline 同源），避免四份实现各自漂移。
import { DEP_PREFIX, DEP_SECTIONS, manifestPaths, ROOT } from "./lib/dsh-deps.mjs";
// 与 publish-gate / dsh-follow-status 同一口径的 semver 校验（共享单一来源，见 issue #6）。
import { VERSION_RE } from "./lib/version-checks.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("--"));
// 合法 semver（含 prerelease / build metadata），与 publish-gate 的
// VERSION_RE 同口径。此前 ^[\w.]+$ 过松：接受下划线/大写/前导零等非法
// 形态，一旦放行会把 5 个 manifest 的 dsh-* range 整块覆写成 npm 无法
// 解析的 range，直到 bun install 才爆。
if (!version || !VERSION_RE.test(version)) {
  console.error("用法: node scripts/adapt-dsh.mjs <版本> [--dry-run]    例: 0.1.2-alpha.4");
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
  // 判定插件兼容性，存在时单独生效）。写成与依赖 range 同形的 `^<版本>`，
  // 让「依赖基线 ↔ 兼容声明」由同一命令保持同步（dsh-baseline.ts 严格核对）。
  // 根 package.json 私有、无 engines.dsh，自然跳过。
  const engines = json.engines !== null && typeof json.engines === "object"
    ? json.engines
    // 发布包至少有一条 dsh-* 依赖（changes 非空）才补 engines 对象；私有根
    // package.json 无 dsh 依赖，不写宿主兼容声明。
    : changes.length > 0 ? (json.engines = {}) : undefined;
  if (engines !== undefined && engines.dsh !== `^${version}`) {
    changes.push(["engines", "dsh", engines.dsh ?? "(缺省)", `^${version}`]);
    engines.dsh = `^${version}`;
  }
  // 旧字段 dsh.host 已废弃（不在官方 DshManifest 契约内），出现即删除。
  if (json.dsh !== null && typeof json.dsh === "object" && Object.hasOwn(json.dsh, "host")) {
    changes.push(["dsh", "host(已废弃)", json.dsh.host, "(删除)"]);
    delete json.dsh.host;
    if (Object.keys(json.dsh).length === 0) delete json.dsh;
  }
  if (changes.length === 0) return;
  for (const [section, name, from, to] of changes) {
    console.log(`  ${rel} [${section}] ${name}: ${from} → ${to}`);
  }
  if (!dryRun) writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

console.log(`适配 DSH 宿主 ${version}${dryRun ? "（dry-run，不写入）" : ""}:`);
for (const rel of manifestPaths()) {
  adaptPackageJson(join(ROOT, rel));
}

console.log(dryRun ? "\n[dry-run] 未写入任何文件。" : "\n已写入。");
console.log("后续手工步骤（详见 RELEASING.md）:");
console.log("  1. 升相关包 package.json 的 version，并在 CHANGELOG.md 记录本次适配");
console.log("  2. bun install 重新生成 lockfile");
console.log("  3. bun run test:ci 验证后提交推送");
