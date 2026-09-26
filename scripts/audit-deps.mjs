// scripts/audit-deps.mjs — 依赖漏洞审计（OSV.dev 公共 API，零外部依赖）。
// 收集根 + 各包 manifest 声明的全部依赖（workspace 自有包排除），从根
// node_modules 读实际安装版本，批量查询 OSV（Google 的漏洞数据库，
// npm advisory 的上游聚合），命中即列出并 exit 1（可直接接 CI）。
// 用法：node scripts/audit-deps.mjs [--deep]   或   bun run audit [--deep]
//   默认审计直接依赖（manifest 声明 + hoisted 版本，快）；
//   --deep 递归收集 node_modules 全树的每个 name@version（传递依赖也审，
//   供应链攻击常藏在传递树里；880+ 包按 100/批分批查询）。
// 需要网络（api.osv.dev 公共接口，无需认证）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEP_SECTIONS, manifestPaths, ROOT } from "./lib/dsh-deps.mjs";

const manifests = manifestPaths(ROOT).map((rel) =>
  JSON.parse(readFileSync(join(ROOT, rel), "utf8")),
);

// workspace 自有包排除：@chaoset/* 的「版本」是本仓 semver，不在 OSV 的
// npm 生态里，查询无意义。
const workspaceNames = new Set(manifests.map((m) => m.name).filter(Boolean));

const deep = process.argv.includes("--deep");

// name@version → 唯一收集键（同版本多路径只查一次；不同版本分别查）。
const deps = new Map();
const collect = (name, version) => {
  if (workspaceNames.has(name)) return;
  if (typeof version !== "string" || version === "") return;
  deps.set(`${name}@${version}`, { name, version });
};

if (deep) {
  // --deep：审计传递依赖。
  // bun 的隔离安装布局是 node_modules/.bun/<name@version>/node_modules/<name>：
  // 包目录是符号链接（isDirectory() 为 false，不能按目录遍历），而 .bun 的
  // 一层目录名就是精确的 name@version——直接解析它，比递归读 package.json
  // 更快更准。scoped 包的 / 存为 +（如 @deepseek-ai+dsh-sandbox@0.1.7-rc.2）。
  const bunStore = join(ROOT, "node_modules", ".bun");
  if (existsSync(bunStore)) {
    for (const entry of readdirSync(bunStore, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const at = entry.name.lastIndexOf("@");
      if (at <= 0) continue; // 形如 name@version；@ 只出现在名内（scoped 存为 +）
      const rawName = entry.name.slice(0, at);
      const version = entry.name.slice(at + 1);
      const name = rawName.startsWith("@") ? rawName.replace("+", "/") : rawName;
      collect(name, version);
    }
  } else {
    // 非 bun 布局（npm/yarn 安装的树）：递归 walk，statSync 跟随符号链接。
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.name.startsWith(".")) continue;
        if (entry.name.startsWith("@")) { walk(full); continue; }
        const pkgJson = join(full, "package.json");
        if (existsSync(pkgJson)) {
          try {
            const { name, version } = JSON.parse(readFileSync(pkgJson, "utf8"));
            if (typeof name === "string") collect(name, version);
          } catch {}
        }
        const nested = join(full, "node_modules");
        if (existsSync(nested)) walk(nested);
      }
    };
    walk(join(ROOT, "node_modules"));
  }
} else {
  // 默认：直接依赖（manifest 声明 + hoisted 主版本）。
  const seenDirect = new Set();
  for (const manifest of manifests) {
    for (const section of DEP_SECTIONS) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (workspaceNames.has(name) || seenDirect.has(name)) continue;
        seenDirect.add(name);
        const pkgJson = join(ROOT, "node_modules", name, "package.json");
        if (!existsSync(pkgJson)) continue; // optionalDependencies 未安装的平台专属包
        const { version } = JSON.parse(readFileSync(pkgJson, "utf8"));
        collect(name, version);
      }
    }
  }
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

if (hits.length === 0) {
  console.log(`audit-deps: ${deps.size} 个依赖（${deep ? "含传递依赖" : "直接依赖"}）未发现已知漏洞。`);
  process.exit(0);
}
console.error(`audit-deps: 发现 ${hits.length} 条已知漏洞：`);
for (const h of hits) {
  console.error(`  ✗ ${h.name}@${h.version}  ${h.id}  ${String(h.summary).split("\n")[0].slice(0, 120)}`);
  console.error(`    https://osv.dev/vulnerability/${h.id}`);
}
process.exit(1);
