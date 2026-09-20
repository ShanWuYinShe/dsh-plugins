// DSH 宿主升级适配：一条命令改齐所有 `@deepseek-ai/dsh-*` 依赖 range
// 的版本号。
// 用法：node scripts/adapt-dsh.mjs <新宿主版本> [--dry-run]
//   例：node scripts/adapt-dsh.mjs 0.1.2-alpha.4
//
// 覆盖范围：根 package.json 与 packages/*/package.json 的 dependencies /
// optionalDependencies / devDependencies / peerDependencies。@deepseek-ai/cordis、
// schemastery 等非 dsh-* 包不在范围内（独立版本线，另行手工升级）。
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

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("--"));
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
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
  // dsh.host 适配声明（发布包的 package.json 声明当前适配的宿主版本，
  // npm 消费者 `npm view <pkg> dsh.host` 可查；根 package.json 私有不
  // 发布、无 dsh 对象，自然跳过。
  if (json.dsh && json.dsh.host !== version) {
    changes.push(["dsh", "host", json.dsh.host ?? "(缺省)", version]);
    json.dsh.host = version;
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
