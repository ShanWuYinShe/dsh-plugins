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
// 用法：node scripts/dsh-follow-status.mjs [--ci] [--strict]
//   --ci      落后/漂移时输出 GitHub Actions `::warning::` annotation
//             （非阻塞，永远 exit 0——这是提醒，不是门禁）。
//   --strict  发布门禁用：main 分支的 dsh 依赖基线必须等于 npm 最新正式版
//             （最新 rc；本项目把 rc 视为该线正式版），或任一分支的 engines.dsh
//             兼容声明与基线不自洽（根 private 不是精确基线、发布包既不是精确
//             基线也不是覆盖基线的同线兼容范围）时报错 exit 1，拒绝发布兼容
//             声明失真的插件；npm registry 不可达时仍按「永远 exit 0」降级为
//             warning（网络抖动不阻塞发布，下一次运行/人工核对补上）。
//
// 本脚本只读：不改任何文件、不 install、不发布。

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { aggregateBaseline, enginesProblems, manifestPaths, ROOT } from "./lib/dsh-deps.mjs";
// 兼容范围示例文案取自同一判据来源（不在这里手写范围形态）。
import { formatCompatRange } from "./lib/engines-compat.mjs";
// 与 publish-gate / adapt-dsh 同一口径的 semver 校验（共享单一来源，见 issue #6）。
import { VERSION_RE, compareVersions, parseVersion } from "./lib/version-checks.mjs";

const ci = process.argv.includes("--ci");
// 发布门禁严格模式：main 基线 ≠ npm 最新正式 rc（或 engines 声明与基线不一致）
// 时 exit 1；npm 不可达时保持降级 exit 0（见文件头「永远 exit 0」承诺）。
const strict = process.argv.includes("--strict");
// 与 publish-gate 钉定同一 registry：本地 .npmrc 指向镜像时，两个脚本对
// 同一 npm 状态必须得出同一结论。
const REGISTRY = "https://registry.npmjs.org";

/** 解析 dsh 版本号为可比较结构（0.1.2-alpha.5 → {n:[0,1,2], pre:["alpha",5]}）。 */
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

/** 检查某分支是否存在（本地或远端 origin/）。 */
function branchExists(branch) {
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: ROOT });
      return true;
    } catch {}
  }
  return false;
}

/** 读某分支的全部 package.json 基线并聚合成单一基线（应全仓一致）；
 *  同时逐 manifest 校验 engines.dsh 兼容声明与基线是否自洽（DSH 官方 manifest
 *  字段，安装/启动据此判定兼容性）：根 private 必须精确等于基线，发布包必须
 *  精确等于基线或覆盖基线的同线兼容范围（判据见 lib/dsh-deps.mjs 的
 *  enginesProblems / lib/engines-compat.mjs，与发布门禁同源）。
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
    // manifest 只读一次：聚合基线 + 逐 manifest 兼容声明校验共用。
    const manifests = new Map(paths.map((path) => [path, read(path)]));
    const { baseline } = aggregateBaseline((path) => manifests.get(path), ROOT, paths);
    const mixed = baseline.startsWith("[不一致");
    // 基线非法（不一致/无依赖/不可读）时无法判断「声明是否覆盖基线」，跳过
    // 兼容声明核对——状态判定本身已按漂移处理。
    const enginesIssues = VERSION_RE.test(baseline)
      ? paths.flatMap((path) => enginesProblems(manifests.get(path), baseline)
        .map((problem) => `${path}: ${problem}`))
      : [];
    const packageDirs = paths
      .filter((p) => p.startsWith("packages/") && p.endsWith("/package.json"))
      .map((p) => p.slice("packages/".length, -"/package.json".length));
    return { baseline, mixed, unreadable: false, packageDirs, enginesIssues };
  } catch {
    return { baseline: "(分支不可读)", mixed: false, unreadable: true, packageDirs: [], enginesIssues: [] };
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
  return p.pre === null || p.pre[0] === "rc";
});
// 兜底：理论上 dsh 总有 rc，但绝不让空数组把诊断脚本打成崩溃（本脚本承诺
// 永远 exit 0）；无 rc/正式版时退回 dist-tag 的 latest。
const stable = stableVersions.length > 0
  ? stableVersions.reduce((a, b) => (compareVersions(a, b) > 0 ? a : b))
  : distTags.latest;
const stableCore = parseVersion(stable);
const stableBase = [stableCore.maj, stableCore.min, stableCore.pat].join(".");
const devVersions = versions.filter((v) => {
  const p = parseVersion(v);
  return p.pre !== null && p.pre[0] !== "rc" && compareVersions(v, stable) > 0;
});
const devLine = devVersions.length > 0
  ? devVersions.reduce((a, b) => (compareVersions(a, b) > 0 ? a : b))
  : null;

const rows = [];
const alphaExists = branchExists("alpha");

for (const branch of ["main", "alpha"]) {
  if (branch === "alpha" && !alphaExists) {
    if (devLine === null) {
      // 待命期：DSH 无新预发布线，无需创建 alpha 分支。
      rows.push({
        branch,
        baseline: "(未创建)",
        enginesIssues: [],
        target: `(待命：等待 >${stableBase} 的新线)`,
        state: "就位(待命)",
        packageDirs: [],
      });
    } else {
      // 活跃期：DSH 出了新预发布线，但尚未创建 alpha 分支。
      rows.push({
        branch,
        baseline: "(未创建)",
        enginesIssues: [],
        target: devLine,
        state: "待从 main 创建",
        packageDirs: [],
      });
    }
    continue;
  }

  const { baseline, enginesIssues, mixed, unreadable, packageDirs } = branchBaseline(branch === head ? null : branch);
  // 基线不是合法版本号（无 dsh 依赖 / 包间不一致 / 分支不可读）时比较
  // 无意义——NaN 会让 compareVersions 的结果静默落进「超前」分支，报出荒谬
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
    const cmp = compareVersions(baseline, stable);
    state = cmp === 0 ? "就位" : cmp < 0 ? "落后" : "超前";
  } else if (devLine !== null) {
    target = devLine;
    const cmp = compareVersions(baseline, devLine);
    state = cmp === 0 ? "就位" : cmp < 0 ? "落后" : "超前";
  } else {
    // 待命：没有进行中的预发布线，alpha 分支仍存在。
    target = `(待命：无新线，建议删除)`;
    const cmp = compareVersions(baseline, stable);
    state = cmp === 0 ? "就位(待命)" : cmp < 0 ? "落后" : "超前";
  }
  rows.push({ branch, baseline, enginesIssues, target, state, packageDirs });
}

console.log(`dsh 稳定线(最新 rc) = ${stable}`);
if (devLine === null) {
  console.log(`进行中预发布线: 无 —— 待命期无需创建 alpha 分支，等待 >${stableBase} 的新 alpha 线`);
  console.log(`💡 阶段指引: 当前处于【待命期】。日常功能演进与修复直接在 main 推进（版本号用纯 semver，发正式版）；无需创建或更新 alpha 分支。`);
} else {
  console.log(`进行中预发布线 = ${devLine}`);
  if (!alphaExists) {
    console.log(`💡 阶段指引: 当前处于【活跃期】。DSH 已发布新预发布线 ${devLine}，请从最新 main 分支创建 alpha 分支开始跟进：git checkout -b alpha main && bun run adapt ${devLine}`);
  } else {
    console.log(`💡 阶段指引: 当前处于【活跃期】。所有功能与修复请在 alpha 推进（版本号用 -alpha.N / -rc.N，发 prerelease）；main 整体搁置。`);
  }
}
let problems = 0;
for (const { branch, baseline, enginesIssues, target, state } of rows) {
  const mark = state.startsWith("就位") ? "✔" : "✖";
  console.log(`${mark} ${branch.padEnd(5)} 依赖基线 ${baseline.padEnd(16)} ↔ ${String(target).padEnd(24)} ${state}`);
  // 兼容声明就位口径：enginesProblems 全空（根精确=基线；发布包精确=基线或
  // 覆盖基线的同线兼容范围）。任何问题都列出来，避免只报第一条漏掉别的包。
  if (enginesIssues.length > 0) {
    problems++;
    const message = `dsh 跟随: ${branch} 分支的 engines.dsh 兼容声明与依赖基线 (${baseline}) 不自洽：${enginesIssues.join("；")}。宿主按 SemVer range 判定兼容性，声明失真会导致插件被判不兼容；请改成精确基线 ${baseline}，或覆盖基线的同线兼容范围（如 ${formatCompatRange(baseline, baseline)}）。`;
    if (ci) console.log(`::warning::${message}`);
    console.log(`⚠ ${message}`);
  }
}

// 单侧独有的包标注：仅在两分支均存在且可读时对比
const rowsByBranch = new Map(rows.map((row) => [row.branch, row]));
if (alphaExists && rows.every((row) => !row.unreadable)) {
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
  if (state === "待从 main 创建") {
    advice = `请从最新 main 分支创建 alpha 分支并跟进：git checkout -b alpha main && bun run adapt ${devLine}`;
  } else if (state === "落后") {
    if (branch === "main") advice = `请在该分支执行 bun run adapt ${stable} 跟进`;
    else if (devLine !== null) advice = `请在该分支执行 bun run adapt ${devLine} 跟进`;
    else advice = "待命期无需保留 alpha 分支，建议删除：git branch -d alpha";
  }
  const message = `dsh 跟随: ${branch} 分支依赖基线 ${baseline} 与跟随目标不一致（${state}，目标 ${target}）。${advice}`;
  if (ci) console.log(`::warning::${message}`);
  console.log(`⚠ ${message}`);
}

// 发布门禁严格模式：正式版发布前，main 必须已经跟到 npm 最新正式版（最新 rc）。
// 注意：npm 不可达已在上面提前 exit 0，不会走到这里（网络抖动不阻塞发布）。
if (strict) {
  const mainRow = rows.find((row) => row.branch === "main");
  const followed = mainRow !== undefined
    && !mainRow.unreadable
    && mainRow.baseline === stable
    && mainRow.state.startsWith("就位");
  if (!followed) {
    const message = `dsh 跟随(严格): main 依赖基线 ${mainRow?.baseline ?? "(缺失)"}`
      + ` ≠ npm 最新正式版 ${stable}（当前状态 ${mainRow?.state ?? "缺失"}）`
      + `——发布正式版前必须先在 main 执行 bun run adapt ${stable} 并重发插件；`
      + `预发布（-alpha/-rc）不受此门禁约束。`;
    if (ci) console.log(`::error::${message}`);
    console.error(`✗ ${message}`);
    process.exit(1);
  }
  if (problems > 0) {
    const message = `dsh 跟随(严格): 存在 ${problems} 项基线/兼容声明问题（见上方 ⚠/✖ 行），拒绝发布。`;
    if (ci) console.log(`::error::${message}`);
    console.error(`✗ ${message}`);
    process.exit(1);
  }
  console.log(`✔ dsh 跟随(严格): main 基线 = npm 最新正式版 ${stable}`);
}
process.exit(0);
