// DSH 宿主跟随状态核对：按 DSH 的发布习惯判定两条分支的跟随目标，对比
// npm 上 @deepseek-ai/dsh 的实际发布与两条分支的 dsh-* 依赖基线，报告谁
// 落后、谁漂移。
//
// 各分支的包清单与基线都从该分支自己读取（git ls-tree 枚举 + git show 逐
// 包读 manifest），不取磁盘列表——磁盘属于当前检出的分支，单侧独有的包
// （如 main 侧没有的 provider-usage）拿去 git show 另一分支会 ENOENT。
// 单侧独有的包在输出中标注「仅 <分支> 侧」（双线活跃期的预期差异，见
// RELEASING.md「功能收敛原则」），不参与跨分支对比。
//
// DSH 的发布习惯（RELEASING.md「宿主跟随规则」）：每条版本线都是
// `<基础号>-alpha.N` 迭代若干版 → 进入 rc（= 稳定候选，即该线的正式版）
// → 该基础号终结（出了正式版就不会再有同基础号的 alpha）→ 下一条线从
// 更高基础号的 `<新基础号>-alpha.0` 重新开始。因此归属判据是版本号语义：
//   main  ↔ 最新 rc（本项目把 dsh 的最新 rc 视为正式版；dsh 从不发布无
//           后缀的纯 X.Y.Z）
//   alpha ↔ 基础号高于该正式版的进行中 -alpha 线；无新线时与 main 同基线
//           待命（分支由最新 main 重建，见「双线生命周期」第 5 步）
// 判定**不使用任何 dist-tag**：latest / next / alpha 都会滞后或错位——同
// 一条 rc 迭代多版时，可能只有首版拿到 latest（2026-09-15 曾实测 latest 指
// 0.1.5-rc.1、更新的 0.1.5-rc.2 挂在 next），拿 dist-tag 当目标会把正确的
// 基线误报成超前。
//
// 用法：node scripts/dsh-follow-status.mjs [--ci]
//   --ci  落后/漂移时输出 GitHub Actions `::warning::` annotation
//         （非阻塞，永远 exit 0——这是提醒，不是门禁）。
//
// 本脚本只读：不改任何文件、不 install、不发布。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateBaseline, manifestPaths, ROOT } from "./lib/dsh-deps.mjs";

const ci = process.argv.includes("--ci");
// 与 publish-gate 钉定同一 registry：本地 .npmrc 指向镜像时，两个脚本对
// 同一 npm 状态必须得出同一结论。
const REGISTRY = "https://registry.npmjs.org";

/** 合法 semver 版本号；基线若不是版本号（哨兵/不一致标记），比较无意义。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 解析 dsh 版本号为可比较结构（0.1.2-alpha.5 → {n:[0,1,2], pre:["alpha",5]}）。 */
function parseVersion(v) {
  const [core, pre = ""] = v.split("-");
  const [major, minor, patch] = core.split(".").map(Number);
  const preParts = pre === "" ? [] : pre.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  return { n: [major, minor, patch], pre: preParts };
}

function cmpVersion(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (A.n[i] !== B.n[i]) return A.n[i] - B.n[i];
  }
  if (A.pre.length === 0 && B.pre.length === 0) return 0;
  // 无 prerelease 的一版更大
  if (A.pre.length === 0) return 1;
  if (B.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const bothNumeric = typeof x === "number" && typeof y === "number";
    if (bothNumeric) return x - y;
    // semver：数字 identifier 小于字符串 identifier
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** 解析分支名到可 git show 的引用：CI 的 checkout 只有 origin/<branch>
 *  远端引用而没有本地分支，本地恰好相反的场景也存在——两者按序回退。 */
function branchRef(branch) {
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT });
      return ref;
    } catch {}
  }
  return branch;
}

/** 读某分支的全部 package.json 基线并聚合成单一基线（应全仓一致）；
 *  同时收集 dsh.host 适配声明（npm 消费者的可见元数据），供一致性核对。
 *  分支不可读（CI checkout 只有当前分支、本地无该分支等）时返回 unmixed
 *  的哨兵形态，由调用方按「无法读取」呈报而非裸栈崩溃。
 *  包清单按目标分支自己枚举（git ls-tree），不取磁盘列表：磁盘列表属于
 *  当前检出的分支，单侧独有的包（如 main 侧没有的 provider-usage）拿去
 *  git show 会 ENOENT，曾把整侧基线误判成「分支不可读」，每日 cron 的
 *  main 侧核对因此长期失效。 */
function branchBaseline(ref) {
  try {
    const resolved = ref === null ? null : branchRef(ref);
    const read = (path) => {
      if (resolved === null) return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
      return JSON.parse(execFileSync("git", ["show", `${resolved}:${path}`], { cwd: ROOT, encoding: "utf8" }));
    };
    // 注意：局部变量不可命名为 manifestPaths——会遮蔽同名 import 并在
    // resolved === null 分支触发 TDZ ReferenceError，令当前分支恒报
    // 「分支不可读」（2026-09-22 实测：HEAD 分支基线永远无法读取）。
    const paths = resolved === null ? manifestPaths(ROOT) : branchManifestPaths(resolved);
    const { baseline, host } = aggregateBaseline(read, ROOT, paths);
    const mixed = baseline.startsWith("[不一致") || host === "[不一致]";
    const packageDirs = paths
      .filter((p) => p.startsWith("packages/") && p.endsWith("/package.json"))
      .map((p) => p.slice("packages/".length, -"/package.json".length));
    return { baseline, host, mixed, unreadable: false, packageDirs };
  } catch {
    return { baseline: "(分支不可读)", host: undefined, mixed: false, unreadable: true, packageDirs: [] };
  }
}

/** 枚举某分支 packages/ 下实际带 package.json 的包目录（git ls-tree 读
 *  该分支的树对象，与磁盘无关）。目录残留但无 package.json 的条目跳过，
 *  与磁盘枚举 manifestPaths 的 existsSync 过滤同语义。 */
function branchManifestPaths(ref) {
  const out = execFileSync("git", ["ls-tree", "--name-only", `${ref}:packages/`], { cwd: ROOT, encoding: "utf8" });
  const names = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const paths = ["package.json"];
  for (const name of names) {
    const manifest = `packages/${name}/package.json`;
    try {
      execFileSync("git", ["cat-file", "-e", `${ref}:${manifest}`]);
      paths.push(manifest);
    } catch {}
  }
  return paths;
}

function currentBranch() {
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

const PKG = "@deepseek-ai/dsh";
// 「永远 exit 0」承诺覆盖 npm 故障：registry 不可达时降级为 warning 跳过
// 本次核对（每日 cron 不该因 npm 抖动而红），而不是让 execFileSync 的裸栈
// 把进程打成 exit 1。
let distTags;
let versions;
try {
  distTags = JSON.parse(execFileSync("npm", ["view", PKG, "dist-tags", "--json", `--registry=${REGISTRY}`], { encoding: "utf8" }));
  versions = JSON.parse(execFileSync("npm", ["view", PKG, "versions", "--json", `--registry=${REGISTRY}`], { encoding: "utf8" }));
} catch (error) {
  const message = `dsh 跟随: npm registry 查询失败，本次跳过核对（${String(error?.message ?? error).split("\n")[0]}）`;
  console.log(ci ? `::warning::${message}` : message);
  process.exit(0);
}
const head = currentBranch();

// ── 按 DSH 发布习惯判定跟随目标 ────────────────────────────────────
// 稳定线目标 = 已发布版本里「非进行中预发布」的最高版：rc 即该线正式版
// （dsh 从不发无后缀纯 X.Y.Z；将来若发，它天然高于同基础号 rc、自动胜出）。
// 越过了 dist-tag——同一条 rc 迭代多版时可能只有首版拿到 latest（2026-09-15
// 曾实测 0.1.5-rc.2 挂在 next、latest 仍指 0.1.5-rc.1），拿 latest 当目标会
// 把已跟到最新 rc 的 main 误报成「超前」。
// 进行中预发布线 = 高于该正式版的最高 -alpha/-beta 版本。
const stableVersions = versions.filter((v) => {
  const p = parseVersion(v);
  return p.pre.length === 0 || p.pre[0] === "rc";
});
// 兜底：理论上 dsh 总有 rc，但绝不让空数组把诊断脚本打成崩溃（本脚本承诺
// 永远 exit 0）；无 rc/正式版时退回 dist-tag 的 latest。
const stable = stableVersions.length > 0
  ? stableVersions.reduce((a, b) => (cmpVersion(a, b) > 0 ? a : b))
  : distTags.latest;
const stableBase = parseVersion(stable).n.join(".");
const devVersions = versions.filter((v) => {
  const p = parseVersion(v);
  return p.pre.length > 0 && p.pre[0] !== "rc" && cmpVersion(v, stable) > 0;
});
const devLine = devVersions.length > 0
  ? devVersions.reduce((a, b) => (cmpVersion(a, b) > 0 ? a : b))
  : null;

const rows = [];
for (const branch of ["main", "alpha"]) {
  const { baseline, host, mixed, unreadable, packageDirs } = branchBaseline(branch === head ? null : branch);
  // 基线不是合法版本号（无 dsh 依赖 / 包间不一致 / 分支不可读）时比较
  // 无意义——NaN 会让 cmpVersion 的结果静默落进「超前」分支，报出荒谬
  // 状态；这里显式归入漂移并说明原因。
  const comparable = !mixed && !unreadable && VERSION_RE.test(baseline);
  let target;
  let state;
  if (unreadable) {
    target = "(无法读取)";
    state = "漂移(分支不可读)";
  } else if (mixed) {
    target = "(基线不一致)";
    state = "漂移(基线不一致)";
  } else if (!comparable) {
    target = stable;
    state = "漂移(基线非版本号)";
  } else if (branch === "main") {
    target = stable;
    const cmp = cmpVersion(baseline, stable);
    state = cmp === 0 ? "就位" : cmp < 0 ? "落后" : "超前";
  } else if (devLine !== null) {
    target = devLine;
    const cmp = cmpVersion(baseline, devLine);
    state = cmp === 0 ? "就位" : cmp < 0 ? "落后" : "超前";
  } else {
    // 待命：没有进行中的预发布线。alpha 分支由最新 main 重建，基线等于
    // 稳定线目标即就位——等 dsh 出更高基础号的新 alpha 线再 adapt 跟进。
    target = `(待命，等待 >${stableBase} 的新线)`;
    const cmp = cmpVersion(baseline, stable);
    state = cmp === 0 ? "就位(待命)" : cmp < 0 ? "落后" : "超前";
  }
  rows.push({ branch, baseline, host, target, state, packageDirs });
}

console.log(`dsh 稳定线(最新 rc) = ${stable}`);
if (devLine === null) {
  console.log(`进行中预发布线: 无 —— alpha 分支待命（与 main 同基线），等待 >${stableBase} 的新 alpha 线`);
  console.log(`💡 阶段指引: 当前处于【待命期】。日常功能演进与修复请在 main 推进（版本号用纯 semver，发正式版）；alpha 待命，切勿在待命期向 alpha 提交新功能或发版。`);
} else {
  console.log(`进行中预发布线 = ${devLine}`);
  console.log(`💡 阶段指引: 当前处于【活跃期】。所有功能与修复请在 alpha 推进（版本号用 -alpha.N / -rc.N，发 prerelease）；main 整体搁置。`);
}
let problems = 0;
for (const { branch, baseline, host, target, state } of rows) {
  const mark = state.startsWith("就位") ? "✔" : "✖";
  console.log(`${mark} ${branch.padEnd(5)} 依赖基线 ${baseline.padEnd(16)} ↔ ${String(target).padEnd(24)} ${state}`);
  if (typeof host === "string" && !host.startsWith("[") && host !== baseline) {
    problems++;
    const message = `dsh 跟随: ${branch} 分支 package.json 的 dsh.host (${host}) 与依赖基线 (${baseline}) 不一致——npm 消费者看到的适配声明失真，请以依赖基线为准修正。`;
    if (ci) console.log(`::warning::${message}`);
    console.log(`⚠ ${message}`);
  }
}

// 单侧独有的包标注：双线活跃期两分支包集存在差异是预期（RELEASING.md
// 「功能收敛原则」），不计为问题；各分支的基线聚合本来就限定在分支自己的
// 包清单内，独有包不参与跨分支对比。任一侧不可读时不标注——空清单会把
// 可读侧的全部包误报成单侧。
const rowsByBranch = new Map(rows.map((row) => [row.branch, row]));
if (rows.every((row) => !row.unreadable)) {
  for (const branch of ["main", "alpha"]) {
    const other = branch === "main" ? "alpha" : "main";
    const otherDirs = new Set(rowsByBranch.get(other).packageDirs);
    for (const dir of rowsByBranch.get(branch).packageDirs) {
      if (!otherDirs.has(dir)) {
        console.log(`ℹ packages/${dir} 仅 ${branch} 侧（${other} 无此包；双线活跃期的预期差异，见 RELEASING.md「功能收敛原则」）`);
      }
    }
  }
}

for (const { branch, baseline, target, state } of rows) {
  if (state.startsWith("就位")) continue;
  problems++;
  let advice = "核对 RELEASING.md「宿主跟随规则」";
  if (state === "落后") {
    if (branch === "main") advice = `请在该分支执行 bun run adapt ${stable} 跟进`;
    else if (devLine !== null) advice = `请在该分支执行 bun run adapt ${devLine} 跟进`;
    // 待命期没有新线可跟：alpha 落后只可能是它没跟上 main，重建即可。
    else advice = "待命期无新线，alpha 应由最新 main 重建：git branch -f alpha main";
  }
  const message = `dsh 跟随: ${branch} 分支依赖基线 ${baseline} 与跟随目标不一致（${state}，目标 ${target}）。${advice}`;
  if (ci) console.log(`::warning::${message}`);
  console.log(`⚠ ${message}`);
}
process.exit(0);
