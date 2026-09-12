// 发布门禁：按「git tag + npm 注册表状态」判定每个包本次是否要发布，
// 取代旧的 diff 式变更检测。状态式判定不依赖推送形状（多提交推送、新分支
// 首推、force push、GitHub Release / workflow_dispatch 触发都一致），且
// 重跑天然幂等：发布中途失败后直接重跑 job，已发布的包会被跳过。
//
// 判定规则（对每个包依次）：
//   1. git tag `<目录>-v<版本>` 已存在           → 静默跳过（该版本已发布并归档）
//   2. npm 上该包不存在 / 该版本不存在           → 发布
//   3. npm 上该版本已存在                        → 警告跳过（tag 机制上线前的历史版本，
//                                                  无法区分「故意不重发」与「忘了升版本」）
//   4. 预发布目标：npm 上存在更高的已发布版本     → 失败（alpha 线是开发前沿，版本号
//      （含稳定线）                                永远高于稳定线；稳定线热修占用基础号后
//                                                  跳下一个基础号）
//      正式版目标：稳定线存在更高版本            → 失败（低于 alpha 在途预发布是合法的
//                                                  晋升/热修路径，semver 保证转正号更大）。
//                                                  任一包失败则本次不发布任何包
//
// stdout 只输出计划 JSON（`[{"dir","name","version","tag"}]`），人类可读
// 日志全部走 stderr——workflow 里用 `PLAN=$(node scripts/publish-gate.mjs)`
// 捕获计划。dist-tag 由版本后缀派生：`0.10.2-alpha.0` → alpha、`1.2.3-rc.4`
// → rc、无后缀 → latest（纯字符串解析，不引入 semver 依赖）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";

const PACKAGES = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

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
    if (xi === undefined) return -1;
    if (yi === undefined) return 1;
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

function gitTagExists(tag) {
  const r = spawnSync("git", ["tag", "-l", tag], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git tag -l ${tag} 失败: ${r.stderr}`);
  return r.stdout.trim() !== "";
}

// 返回 npm 上已发布的全部版本；包不存在（E404）返回空数组。其他错误（网络
// 等）直接抛出、中止整个 job——绝不吞成「未发布」，那会导致对已存在版本的
// 重发被 npm 拒绝，且环境问题本就应当中止发布。E404 判定要求 stderr 同时
// 呈现错误码与 404 字样，避免恰好含 "E404" 字样的其他输出（如镜像地址）
// 被误判成「包不存在 → 可发布」。
function npmVersions(name) {
  const r = spawnSync("npm", ["view", name, "versions", "--json", `--registry=${REGISTRY}`], {
    encoding: "utf8",
  });
  if (r.status === 0) {
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new Error(`npm view ${name} 输出不是合法 JSON，无法判定发布状态:\n${String(r.stdout).slice(0, 200)}`);
    }
  }
  if (/\bE404\b/.test(r.stderr) && /\b404\b/.test(r.stderr)) return [];
  throw new Error(`npm view ${name} 失败（非 404，疑似网络/registry 问题）:\n${r.stderr}`);
}

function distTag(version) {
  if (!isPrerelease(version)) return "latest";
  const m = version.match(/^[^-]*-([A-Za-z][A-Za-z0-9]*)/);
  // dist-tag 名取字母开头的首标识符（本仓的 -alpha.N / -rc.N）。其余
  // prerelease 形状（如纯数字首标识符 1.2.3-1，本仓不会产生）退回第一段
  // 原文——关键是「是否 prerelease」的判定永远与 distTag/isStable 同口径，
  // 不让纯数字 prerelease 被误判成稳定版、发出去直接覆盖 latest。
  return m ? m[1] : version.slice(version.indexOf("-") + 1);
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

const plan = [];
let failed = false;

// 合法 semver（含 prerelease / build metadata）。非法版本号若放行，
// compareVersions 会产出 NaN 静默通过「落后于 npm」比较。
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

for (const dir of PACKAGES) {
  const { name, version } = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));

  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    log(`✗ ${name} 的版本号 ${JSON.stringify(version)} 不是合法 semver，拒绝发布。请修正 package.json 的 version。`);
    failed = true;
    continue;
  }

  if (gitTagExists(`${dir}-v${version}`)) {
    log(`= ${name}@${version} 已有 git tag ${dir}-v${version}，跳过（已发布并归档）`);
    continue;
  }

  const published = npmVersions(name);
  if (published.includes(version)) {
    log(`! ${name}@${version} 已在 npm 上但无 git tag（tag 机制上线前的历史版本），跳过。若这是新改动，请升版本号后再推。`);
    continue;
  }

  // 预发布目标是开发前沿，必须高于 npm 上所有已发布版本（含稳定线）；
  // 正式版目标只要求高于稳定线已有版本——低于 alpha 线在途预发布是合法的
  // 晋升/热修路径（semver 保证其转正号大于这些预发布）。
  const newer = published.find((v) =>
    (isStable(version) ? isStable(v) : true) && compareVersions(v, version) > 0
  );
  if (newer) {
    log(`✗ ${name}@${version} 落后于 npm 上已有的 ${newer}${isStable(version) ? "（稳定线）" : "——预发布版本必须高于所有已发布版本，含稳定线"}，拒绝发布。请升 package.json 的 version 并补 CHANGELOG。`);
    failed = true;
    continue;
  }

  log(`→ ${name}@${version} 计划发布，dist-tag: ${distTag(version)}`);
  if (!changelogHasSection(dir, version)) {
    log(`! ${name}@${version} 在 CHANGELOG.md 中没有对应小节，GitHub Release 说明将使用占位文本。`);
  }
  plan.push({ dir, name, version, tag: distTag(version) });
}

if (failed) {
  log("存在版本号落后于 npm 的包，本次不发布任何包（整体失败）。");
  process.exit(1);
}

console.log(JSON.stringify(plan));
