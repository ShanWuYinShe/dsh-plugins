/**
 * config-validate.ts — 额外可写根的配置校验与规范化。
 *
 * 2026-10-08 从 416 行的 apply.ts 拆出：remote.set 的严格校验（非法数组 / 相对路径直接拒绝）
 * 与只接受绝对路径的规范化（canonical 化后按危险根分级剔除）。
 *
 * @module sandbox-extra-roots/config-validate
 */

import { isAbsolute } from 'node:path'
import { canon, expandTilde, classifyRoot } from './roots.js'

// remote.set 严格校验：非法数组/相对路径直接拒绝，UI 能立即看到原因。
export function validateSandboxConfig(partial: any) {
  if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
    throw new TypeError("sandbox-extra-roots config must be a plain object");
  }
  if (partial.extraWritableRoots !== void 0) {
    if (!Array.isArray(partial.extraWritableRoots)) {
      throw new TypeError('sandbox-extra-roots config field "extraWritableRoots" must be an array');
    }
    for (const rawRoot of partial.extraWritableRoots) {
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
}

// 只接受绝对路径:相对路径/空值会破坏词法包含判断,直接拒绝并告警。
// canonical 化后做危险根分类:reject 级("/"等)在此兜底过滤(patch/YAML
// 不经过 remote.set 校验),filter 级系统目录 warn 后一并剔除。
export function normalizeRoots(c: any, warn: (message: string) => void) {
  const roots = Array.isArray(c.extraWritableRoots) ? c.extraWritableRoots : [];
  if (!Array.isArray(c.extraWritableRoots)) {
    warn("sandbox-extra-roots: extraWritableRoots must be an array of absolute paths; ignoring current config");
  }
  const expanded = roots.map((root: any) => (typeof root === "string" ? expandTilde(root) : root));
  const normalized = expanded
    .filter((root: any) => {
      if (typeof root === "string" && root.length > 0 && isAbsolute(root)) return true;
      warn(`sandbox-extra-roots: ignoring non-absolute extra writable root ${JSON.stringify(root)}`);
      return false;
    })
    .map((root: any) => canon(root))
    .filter((canonical: string) => {
      const verdict = classifyRoot(canonical);
      if (verdict === null) return true;
      warn(verdict === "reject"
        ? `sandbox-extra-roots: ignoring dangerous extra writable root ${JSON.stringify(canonical)}; granting it would disable the sandbox boundary`
        : `sandbox-extra-roots: ignoring system directory ${JSON.stringify(canonical)} as extra writable root`);
      return false;
    });
  return [...new Set(normalized)];
}
