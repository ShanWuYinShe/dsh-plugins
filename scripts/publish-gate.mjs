// 发布门禁：按「git tag 归档状态」判定每个包本次是否要发布。发布渠道为
// GitHub Release tarball 资产（见 RELEASING.md），不再经过 npm registry。
// 状态式判定不依赖推送形状（多提交推送、新分支首推、force push、workflow
// dispatch 触发都一致），且重跑天然幂等：发布中途失败后直接重跑 job，
// 已归档的包会被跳过。
//
// 判定规则（对每个包依次）：
//   1. git tag `<目录>-v<版本>` 已存在              → 静默跳过（该版本已发布并归档）
//   2. 该包已有 git tag 中存在更高的已归档版本       → 失败（改了代码没升版本号从此是
//                                                    红灯，不是静默跳过；任一包失败则
//                                                    本次不发布任何包）
//      比较口径与 npm 时代一致：预发布目标必须高于
//      所有已归档版本（含稳定线）；正式版目标只与
//      已归档的稳定版比较——低于 alpha 在途预发布是
//      合法的晋升/热修路径（semver 保证转正号更大）。
//   3. 否则                                         → 发布（pnpm pack → GitHub Release
//                                                      资产，tag 与资产名见 workflow）
//
// stdout 只输出计划 JSON（`[{"dir","name","version","prerelease"}]`），人类可读
// 日志全部走 stderr——workflow 里用 `PLAN=$(node scripts/publish-gate.mjs)`
// 捕获计划。prerelease 布尔（版本带 `-` 即真）供 workflow 决定 GitHub Release
// 是否打 prerelease 标记；版本形态的约定（-alpha.N / -rc.N / 无后缀）见
// RELEASING.md「版本号规则」。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGES = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

// 合法 semver（含 prerelease / build metadata）。非法版本号若放行，
// compareVersions 会产出 NaN 静默通过「落后于已归档版本」比较。
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// semver 比较（不含 prerelease 与 build metadata 以外的差异）：主/次/补丁按
// 数值比；带 prerelease 的版本小于同号正式版；prerelease 标识符逐段比，数字
// 段小于字母段，段数少的是前缀、更小。语义与 npm 一致。
function compareVersions(a, b) {
  function parse(v) {
    const plus = v.indexOf("+");
    const noBuild = plus === -1 ? v : v.slice(0, plus); // build metadata 不参与比较
    const dash = noBuild.indexOf("-");
    const core = dash === -1 ? noBuild : noBuild.slice(0, dash);
    const [maj, min, pat] = core.split(".").map(Number);
    return { maj, min, pat, pre: dash === -1 ? null : noBuild.slice(dash + 1).split(".") };
  }
  const x = parse(a);
  const y = parse(b);
  for (const k of ["maj", "min", "pat"]) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const xi = x.pre[i];
    const yi = y.pre[i];
    const nx = /^\d+$/.test(xi);
    const ny = /^\d+$/.test(yi);
    if (nx && ny) {
      const d = Number(xi) - Number(yi);
      if (d) return d;
    } else if (nx) {
      return -1;
    } else if (ny) {
      return 1;
    } else if (xi !== yi) {
      return xi < yi ? -1 : 1;
    }
  }
  return 0;
}

function log(...args) {
  console.error(...args);
}

// 本仓库全部 git tag（一次调用，供所有包共用）。CI checkout 用 fetch-depth: 0
// 拿全量 tag；本地干跑若 tag 落后于远程只会多判定「可发布」，不影响 CI。
function gitTags() {
  const r = spawnSync("git", ["tag", "-l"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git tag -l 失败: ${r.stderr}`);
  return new Set(r.stdout.split("\n").filter(Boolean));
}

// 版本是否带 prerelease 后缀。与 compareVersions 的判定同口径：出现第一个
// `-` 即 prerelease，不看标识符内容（semver 对纯数字首标识符同样视为
// prerelease）。
function isPrerelease(version) {
  return version.includes("-");
}

// 版本是否属于稳定线（无 prerelease 后缀）。
function isStable(version) {
  return !isPrerelease(version);
}

// CHANGELOG 是否有该版本的小节（与 scripts/release-notes.mjs 同一判定）。
// 缺失不阻断发布，但 GitHub Release 说明会退化为占位文本，提前警告。
function changelogHasSection(dir, version) {
  const p = join(ROOT, "packages", dir, "CHANGELOG.md");
  if (!existsSync(p)) return false;
  return readFileSync(p, "utf8")
    .split("\n")
    .some((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
}

const tags = gitTags();
const plan = [];
let failed = false;

for (const dir of PACKAGES) {
  const { name, version } = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));

  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    log(`✗ ${name} 的版本号 ${JSON.stringify(version)} 不是合法 semver，拒绝发布。请修正 package.json 的 version。`);
    failed = true;
    continue;
  }

  const archiveTag = `${dir}-v${version}`;
  if (tags.has(archiveTag)) {
    log(`= ${name}@${version} 已有 git tag ${archiveTag}，跳过（已发布并归档）`);
    continue;
  }

  // 该包已归档的全部版本（tag `<目录>-v<版本>`，解析不出的条目忽略——
  // 留给人为打的其他用途 tag，不参与版本比较）。
  const archived = [...tags]
    .filter((t) => t.startsWith(`${dir}-v`))
    .map((t) => t.slice(dir.length + 2))
    .filter((v) => VERSION_RE.test(v));

  // 预发布目标是开发前沿，必须高于所有已归档版本（含稳定线）；正式版目标
  // 只要求高于已归档的稳定版——低于 alpha 线在途预发布是合法的晋升/热修
  // 路径（semver 保证其转正号大于这些预发布）。
  const newer = archived.find((v) =>
    (isStable(version) ? isStable(v) : true) && compareVersions(v, version) > 0
  );
  if (newer) {
    log(`✗ ${name}@${version} 落后于已归档的 ${newer}${isStable(version) ? "（稳定线）" : "——预发布版本必须高于所有已归档版本，含稳定线"}，拒绝发布。请升 package.json 的 version 并补 CHANGELOG。`);
    failed = true;
    continue;
  }

  log(`→ ${name}@${version} 计划发布（GitHub Release ${archiveTag}${isPrerelease(version) ? "，prerelease 标记" : ""}）`);
  if (!changelogHasSection(dir, version)) {
    log(`! ${name}@${version} 在 CHANGELOG.md 中没有对应小节，GitHub Release 说明将使用占位文本。`);
  }
  plan.push({ dir, name, version, prerelease: isPrerelease(version) });
}

if (failed) {
  log("存在版本号落后于已归档版本的包，本次不发布任何包（整体失败）。");
  process.exit(1);
}

console.log(JSON.stringify(plan));
