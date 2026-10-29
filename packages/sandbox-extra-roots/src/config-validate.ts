/**
 * config-validate.ts — 额外可写根的配置校验与规范化。
 *
 * remote.set 的严格校验（非法数组 / 相对路径 / 危险根直接拒绝，UI 能立即看到
 * 原因）与 apply 入口的规范化（只接受绝对路径，canonical 化后按危险根分级剔除）。
 *
 * @module @chaoset/sandbox-extra-roots/config-validate
 */

import { isAbsolute } from 'node:path'
import { canon, expandTilde, classifyRoot } from './roots.js'
import type { SandboxExtraRootsConfig } from './types.js'

/** 把未知输入收窄成"可能是配置对象"的最小视图（字段逐项运行时校验）。 */
function asPartialConfig(value: unknown): Partial<SandboxExtraRootsConfig> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<SandboxExtraRootsConfig>
    : {}
}

// remote.set 严格校验：非法数组/相对路径直接拒绝，UI 能立即看到原因。
export function validateSandboxConfig(partial: unknown): void {
  if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
    throw new TypeError("sandbox-extra-roots config must be a plain object");
  }
  const roots: unknown = (partial as { extraWritableRoots?: unknown }).extraWritableRoots;
  if (roots === void 0) return;
  if (!Array.isArray(roots)) {
    throw new TypeError('sandbox-extra-roots config field "extraWritableRoots" must be an array');
  }
  for (const rawRoot of roots) {
    const root = typeof rawRoot === "string" ? expandTilde(rawRoot) : rawRoot;
    if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
      throw new TypeError(`sandbox-extra-roots: extra writable root must be a non-empty absolute path: ${JSON.stringify(root)}`);
    }
    // 危险根直接拒绝:canonical 后等于 "/"、Windows 盘根或用户主目录
    // 本身,授予它等于放弃整个沙盒边界。信息带原始值,UI 能看到原因。
    const canonical = canon(root);
    if (classifyRoot(canonical) === "reject") {
      throw new TypeError(`sandbox-extra-roots: refusing dangerous extra writable root ${JSON.stringify(root)} (resolves to ${canonical}); granting it would effectively disable the sandbox`);
    }
  }
}

// 只接受绝对路径:相对路径/空值会破坏词法包含判断,直接拒绝并告警。
// canonical 化后做危险根分类:reject 级("/"等)在此兜底过滤(patch/YAML
// 不经过 remote.set 校验),filter 级系统目录 warn 后一并剔除。
export function normalizeRoots(source: unknown, warn: (message: string) => void): string[] {
  const config = asPartialConfig(source);
  const roots = Array.isArray(config.extraWritableRoots) ? config.extraWritableRoots : [];
  if (!Array.isArray(config.extraWritableRoots)) {
    warn("sandbox-extra-roots: extraWritableRoots must be an array of absolute paths; ignoring current config");
  }
  const expanded = roots.map((root) => (typeof root === "string" ? expandTilde(root) : root));
  const normalized = expanded
    .filter((root): root is string => {
      if (typeof root === "string" && root.length > 0 && isAbsolute(root)) return true;
      warn(`sandbox-extra-roots: ignoring non-absolute extra writable root ${JSON.stringify(root)}`);
      return false;
    })
    .map((root) => canon(root))
    .filter((canonical) => {
      const verdict = classifyRoot(canonical);
      if (verdict === null) return true;
      warn(verdict === "reject"
        ? `sandbox-extra-roots: ignoring dangerous extra writable root ${JSON.stringify(canonical)}; granting it would disable the sandbox boundary`
        : `sandbox-extra-roots: ignoring system directory ${JSON.stringify(canonical)} as extra writable root`);
      return false;
    });
  return [...new Set(normalized)];
}
