// DSH 宿主升级适配：一条命令改齐所有 `@deepseek-ai/dsh-*` 依赖 range 与
// pnpm-workspace.yaml 里 minimumReleaseAgeExclude 清单的版本号。
// 用法：node scripts/adapt-dsh.mjs <新宿主版本> [--dry-run]
//   例：node scripts/adapt-dsh.mjs 0.1.2-alpha.4
//
// 覆盖范围：根 package.json 与 packages/*/package.json 的 dependencies /
// optionalDependencies / devDependencies / peerDependencies。@deepseek-ai/cordis、
// schemastery 等非 dsh-* 包不在范围内（独立版本线，另行手工升级）。
//
// 脚本不做的事（按 RELEASING.md 手工完成）：
//   - 升各包版本号、写 CHANGELOG（发布决策）
//   - pnpm install 重新生成 lockfile（需要网络）

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("--"));
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("用法: node scripts/adapt-dsh.mjs <版本> [--dry-run]    例: 0.1.2-alpha.4");
  process.exit(2);
}

const DEP_PREFIX = "@deepseek-ai/dsh-";
const SECTIONS = ["dependencies", "optionalDependencies", "devDependencies", "peerDependencies"];

function adaptPackageJson(path) {
  const rel = relative(ROOT, path);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const changes = [];
  for (const section of SECTIONS) {
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

// 从 pnpm-lock.yaml 提取当前 @deepseek-ai/dsh-* 闭包的包名，整块重建
// minimumReleaseAgeExclude 清单（全部指向新版本）。闭包重建而非逐行改写：
// 宿主新版本常引入新的 dsh 子依赖，逐行改写会漏掉它们——新版本通常发布
// 未满 24 小时，install 会因供应链门槛解析不到而直接失败。清单不存在的
// 分支（稳定线）跳过。
function adaptWorkspaceYaml() {
  const path = join(ROOT, "pnpm-workspace.yaml");
  const text = readFileSync(path, "utf8");
  const listStart = text.indexOf("minimumReleaseAgeExclude:");
  if (listStart === -1) {
    console.log("  pnpm-workspace.yaml: 无 minimumReleaseAgeExclude 清单，跳过（稳定线无需排除）");
    return;
  }
  const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
  const names = new Set();
  for (const m of lock.matchAll(/@deepseek-ai\/(dsh-[a-z0-9-]+)/g)) names.add(m[1]);
  const entries = [...names].sort().map((n) => `  - '@deepseek-ai/${n}@${version}'`);
  const rest = text.slice(listStart).split("\n");
  let end = 1;
  while (end < rest.length && !/^[A-Za-z]/.test(rest[end])) end++;
  const block = ["minimumReleaseAgeExclude:", ...entries, ""].join("\n");
  if (!dryRun) writeFileSync(path, text.slice(0, listStart) + block + rest.slice(end).join("\n"));
  console.log(`  pnpm-workspace.yaml [minimumReleaseAgeExclude] 从 lockfile 闭包重建：${entries.length} 项 → @${version}${dryRun ? "（dry-run，未写入）" : ""}`);
}

console.log(`适配 DSH 宿主 ${version}${dryRun ? "（dry-run，不写入）" : ""}:`);
adaptPackageJson(join(ROOT, "package.json"));
for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
  if (entry.isDirectory()) adaptPackageJson(join(ROOT, "packages", entry.name, "package.json"));
}
adaptWorkspaceYaml();

console.log(dryRun ? "\n[dry-run] 未写入任何文件。" : "\n已写入。");
console.log("后续手工步骤（详见 RELEASING.md）:");
console.log("  1. 升相关包 package.json 的 version，并在 CHANGELOG.md 记录本次适配");
console.log("  2. pnpm install 重新生成 lockfile");
console.log("  3. pnpm run test:ci 验证后提交推送");
