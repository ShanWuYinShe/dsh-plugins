// scripts/audit-deps.mjs — 依赖漏洞审计（OSV.dev 公共 API，零外部依赖）。
// 收集根 + 各包 manifest 声明的全部依赖（workspace 自有包排除），从根
// node_modules 读实际安装版本，批量查询 OSV（Google 的漏洞数据库，
// npm advisory 的上游聚合），命中即列出并 exit 1（可直接接 CI）。
// 用法：node scripts/audit-deps.mjs [--deep]   或   bun run audit [--deep]
//   默认审计直接依赖（manifest 声明 + hoisted 版本，快）；
//   --deep 递归收集 node_modules 全树的每个 name@version（传递依赖也审，
//   供应链攻击常藏在传递树里；数百包按 100/批分批查询，实测约 280 个）。
// 需要网络（api.osv.dev 公共接口，无需认证）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { manifestPaths, ROOT } from "./lib/dsh-deps.mjs";
import { collectBunStoreEntries, collectDirectDeps, collectWalkTree } from "./lib/dep-collect.mjs";

const manifestPathsList = manifestPaths(ROOT);
const manifests = manifestPathsList.map((rel) =>
  JSON.parse(readFileSync(join(ROOT, rel), "utf8")),
);
/** 每个 manifest 所在目录：默认模式按各自解析面取实际安装版本。 */
const manifestDirs = manifestPathsList.map((rel) => join(ROOT, rel, ".."));

// workspace 自有包排除：@chaoset/* 的「版本」是本仓 semver，不在 OSV 的
// npm 生态里，查询无意义。
const workspaceNames = new Set(manifests.map((m) => m.name).filter(Boolean));

const deep = process.argv.includes("--deep");

/**
 * 已接受风险：命中项按 `<附告警 id> <包名>@<版本>` 登记，**必须逐条写明为什么
 * 本仓不受影响、或为什么不能单方面升级**。只登记确定无法在本仓内消解的项，
 * 并在宿主基线升级后复核删除（security-audit 的深层审计仍会引用这些条目）。
 */
const ACCEPTED_ADVISORIES = new Map([
  [
    "GHSA-mrhx-c7xc-m3w5 zod@4.4.3",
    "zod 只在本仓 devDependencies 里精确 pin 4.4.3（Typert 生成工件运行期从宿主平台表取同名实例，"
      + "发布物零运行期依赖、不携带 zod）；该版本与宿主 DSH 0.2.2-rc.1 各包解析一致，单方面升级会与"
      + "宿主运行时的 zod 实例不匹配。等宿主基线升级 zod 后随 adapt 同步。",
  ],
]);

// 收集逻辑见 ./lib/dep-collect.mjs（纯逻辑 + 单测）；这里只做分支选择与 I/O 供给。
let deps;

if (deep) {
  // --deep：审计传递依赖。
  // bun 的隔离安装布局是 node_modules/.bun/<name@version>/node_modules/<name>：
  // 包目录是符号链接（isDirectory() 为 false，不能按目录遍历），而 .bun 的
  // 一层目录名就是精确的 name@version——直接解析它，比递归读 package.json
  // 更快更准。scoped 包的 / 存为 +（如 @deepseek-ai+dsh-sandbox@0.1.7-rc.2）。
  const bunStore = join(ROOT, "node_modules", ".bun");
  if (existsSync(bunStore)) {
    // 目录是符号链接故只取目录项名；解析逻辑在 parseBunStoreEntry（有单测）。
    const entryNames = readdirSync(bunStore, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    deps = collectBunStoreEntries(entryNames, workspaceNames);
  } else {
    // 非 bun 布局（npm/yarn 安装的树）：递归 walk，逻辑在 collectWalkTree（有单测）。
    deps = collectWalkTree(join(ROOT, "node_modules"), workspaceNames);
  }
} else {
  // 默认：直接依赖。必须按**每个 manifest 自己的解析面**取实际版本：
  // bun 是隔离安装，49 条第三方声明里只有约 15 条 hoisted 到根 node_modules，
  // 只看根目录会静默漏查 2/3（2026-11-04 审计发现）。createRequire 以各包
  // package.json 为基准，等价于该包运行时真正的解析结果。
  const resolvers = manifestDirs.map((dir) => createRequire(join(dir, "package.json")));
  const readVersion = (name) => {
    for (const requireFrom of resolvers) {
      try {
        return requireFrom(`${name}/package.json`).version;
      } catch {
        // 该解析面没有它 → 试下一个（optionalDependencies 的平台专属包可能都没装）
      }
    }
    return undefined;
  };
  deps = collectDirectDeps(manifests, workspaceNames, readVersion);
}

if (deps.size === 0) {
  console.error("audit-deps: 未收集到任何依赖（先 bun install）。");
  process.exit(2);
}
console.error(`audit-deps: 查询 ${deps.size} 个依赖（OSV.dev）…`);

// 分批查询（100/批：OSV 对单请求体量有隐式上限，批小重试代价小）。
const all = [...deps.values()];
const BATCH = 100;
const hits = [];
for (let offset = 0; offset < all.length; offset += BATCH) {
  const batch = all.slice(offset, offset + BATCH);
  const res = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: batch.map(({ name, version }) => ({
        package: { name, ecosystem: "npm" },
        version,
      })),
    }),
  });
  if (!res.ok) {
    console.error(`audit-deps: OSV 查询失败 HTTP ${res.status}；网络不可达时跳过本检查，勿带病发布。`);
    process.exit(2);
  }
  const { results } = await res.json();
  batch.forEach(({ name, version }, i) => {
    for (const v of results[i]?.vulns ?? []) hits.push({ name, version, id: v.id });
  });
}
// querybatch 只回 id：对命中项逐个拉详情取 summary（命中通常个位数，代价可忽略）。
await Promise.all(hits.map(async (h) => {
  try {
    const detail = await fetch(`https://api.osv.dev/v1/vulns/${h.id}`);
    if (detail.ok) {
      const body = await detail.json();
      h.summary = body.summary ?? "";
    }
  } catch {}
}))

const keyOf = (h) => `${h.id} ${h.name}@${h.version}`;
const accepted = hits.filter((h) => ACCEPTED_ADVISORIES.has(keyOf(h)));
const blocking = hits.filter((h) => !ACCEPTED_ADVISORIES.has(keyOf(h)));

for (const h of accepted) {
  console.error(`  △ ${h.name}@${h.version}  ${h.id}（已接受风险：${ACCEPTED_ADVISORIES.get(keyOf(h))}）`);
  console.error(`    https://osv.dev/vulnerability/${h.id}`);
}
if (blocking.length === 0) {
  console.log(
    `audit-deps: ${deps.size} 个依赖（${deep ? "含传递依赖" : "直接依赖"}）未发现未接受的已知漏洞`
      + (accepted.length === 0 ? "。" : `（${accepted.length} 条已接受风险见上）。`),
  );
  process.exit(0);
}
console.error(`audit-deps: 发现 ${blocking.length} 条已知漏洞：`);
for (const h of blocking) {
  console.error(`  ✗ ${h.name}@${h.version}  ${h.id}  ${String(h.summary).split("\n")[0].slice(0, 120)}`);
  console.error(`    https://osv.dev/vulnerability/${h.id}`);
}
console.error("audit-deps: 无法合理消解的风险请登记到 ACCEPTED_ADVISORIES 并写明理由。");
process.exit(1);
