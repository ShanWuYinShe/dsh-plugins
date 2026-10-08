// scripts/lib/dep-collect.mjs — 依赖收集的纯逻辑（audit-deps.mjs 用）。
// 本模块只做收集与解析，不做网络与 exit/log 决策（策略留给调用方）。
// 收集键为 name@version：同版本多路径只查一次，不同版本分别查。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEP_SECTIONS } from "./dsh-deps.mjs";

/** 收集键：同版本多路径只查一次，不同版本分别查。 */
export function depKey(name, version) {
  return `${name}@${version}`;
}

/**
 * 解析 bun 隔离布局的 store 条目名（node_modules/.bun 下一层目录名）。
 * 包目录是符号链接（isDirectory() 为 false，不能按目录遍历），而 .bun 的
 * 一层目录名就是精确的 name@version——直接解析它，比递归读 package.json
 * 更快更准。scoped 包的 / 存为 +（如 @deepseek-ai+dsh-sandbox@0.1.7-rc.2）。
 * 只做形态拆分：空版本与否由收集器统一判定（单规则位置）。
 * @returns {{ name, version } | null} 形态不符（无 @ / @ 开头）返回 null。
 */
export function parseBunStoreEntry(entryName) {
  const at = entryName.lastIndexOf("@");
  if (at <= 0) return null; // 形如 name@version；@ 只出现在名内（scoped 存为 +）
  const rawName = entryName.slice(0, at);
  const version = entryName.slice(at + 1);
  const name = rawName.startsWith("@") ? rawName.replace("+", "/") : rawName;
  return { name, version };
}

/**
 * 收集器：workspace 自有包排除（@chaoset/* 的版本不在 OSV npm 生态里，查无意义），
 * 空/非法版本跳过，同 name@version 去重。
 */
export function createCollector(workspaceNames) {
  const deps = new Map();
  const collect = (name, version) => {
    if (workspaceNames.has(name)) return;
    if (typeof version !== "string" || version === "") return;
    deps.set(depKey(name, version), { name, version });
  };
  return { deps, collect };
}

/** --deep 的 bun 布局分支：把一层目录名清单变成收集结果（调用方已过滤出目录项）。 */
export function collectBunStoreEntries(entryNames, workspaceNames) {
  const { deps, collect } = createCollector(workspaceNames);
  for (const entryName of entryNames) {
    const parsed = parseBunStoreEntry(entryName);
    if (parsed === null) continue;
    collect(parsed.name, parsed.version);
  }
  return deps;
}

/**
 * 默认分支：manifest 声明的直接依赖 + hoisted 主版本。
 * readVersion(name) 由调用方提供：缺失（optionalDependencies 的平台专属包可能没装）
 * 时返回 undefined，即跳过。
 */
export function collectDirectDeps(manifests, workspaceNames, readVersion) {
  const { deps, collect } = createCollector(workspaceNames);
  const seenDirect = new Set();
  for (const manifest of manifests) {
    for (const section of DEP_SECTIONS) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (workspaceNames.has(name) || seenDirect.has(name)) continue;
        seenDirect.add(name);
        collect(name, readVersion(name));
      }
    }
  }
  return deps;
}

/**
 * 非 bun 布局（npm/yarn 安装的树）：递归 walk node_modules 收集每个 name@version。
 * 点开头目录跳过；@scope 先下钻一层；每个目录读 package.json（坏文件跳过不炸）；
 * 嵌套 node_modules 继续下钻。statSync 语义跟随符号链接。
 * 直接读真实 fs：调用方给根目录，测试用临时目录树驱动（见 dep-collect.test.ts）。
 */
export function collectWalkTree(nodeModulesDir, workspaceNames) {
  const { deps, collect } = createCollector(workspaceNames);
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
  walk(nodeModulesDir);
  return deps;
}
