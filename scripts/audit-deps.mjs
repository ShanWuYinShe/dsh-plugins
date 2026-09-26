// scripts/audit-deps.mjs — 依赖漏洞审计（OSV.dev 公共 API，零外部依赖）。
// 收集根 + 各包 manifest 声明的全部依赖（workspace 自有包排除），从根
// node_modules 读实际安装版本，批量查询 OSV（Google 的漏洞数据库，
// npm advisory 的上游聚合），命中即列出并 exit 1（可直接接 CI）。
// 用法：node scripts/audit-deps.mjs   或   bun run audit
// 需要网络（api.osv.dev 公共接口，无需认证）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEP_SECTIONS, manifestPaths, ROOT } from "./lib/dsh-deps.mjs";

const manifests = manifestPaths(ROOT).map((rel) =>
  JSON.parse(readFileSync(join(ROOT, rel), "utf8")),
);

// workspace 自有包排除：@chaoset/* 的「版本」是本仓 semver，不在 OSV 的
// npm 生态里，查询无意义。
const workspaceNames = new Set(manifests.map((m) => m.name).filter(Boolean));

// 依赖名 → 实际安装版本（读根 node_modules 的 hoisted 主版本；嵌套多版本
// 场景 bun workspace 下少见，审计以主版本为准）。
const deps = new Map();
for (const manifest of manifests) {
  for (const section of DEP_SECTIONS) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (workspaceNames.has(name) || deps.has(name)) continue;
      const pkgJson = join(ROOT, "node_modules", name, "package.json");
      if (!existsSync(pkgJson)) continue; // optionalDependencies 未安装的平台专属包
      const { version } = JSON.parse(readFileSync(pkgJson, "utf8"));
      if (typeof version === "string") deps.set(name, version);
    }
  }
}

if (deps.size === 0) {
  console.error("audit-deps: 未收集到任何依赖（先 bun install）。");
  process.exit(2);
}
console.error(`audit-deps: 查询 ${deps.size} 个依赖（OSV.dev）…`);

const res = await fetch("https://api.osv.dev/v1/querybatch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    queries: [...deps.entries()].map(([name, version]) => ({
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

const hits = [];
let index = 0;
for (const [name, version] of deps) {
  for (const v of results[index]?.vulns ?? []) hits.push({ name, version, id: v.id });
  index += 1;
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

if (hits.length === 0) {
  console.log(`audit-deps: ${deps.size} 个依赖未发现已知漏洞。`);
  process.exit(0);
}
console.error(`audit-deps: 发现 ${hits.length} 条已知漏洞：`);
for (const h of hits) {
  console.error(`  ✗ ${h.name}@${h.version}  ${h.id}  ${String(h.summary).split("\n")[0].slice(0, 120)}`);
  console.error(`    https://osv.dev/vulnerability/${h.id}`);
}
process.exit(1);
