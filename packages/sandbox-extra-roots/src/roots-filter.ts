/**
 * roots-filter.ts — 额外可写根的「真实存在目录」过滤（带 TTL 缓存）。
 *
 * 2026-10-08 从 416 行的 apply.ts 拆出：bwrap/Landlock 的 --bind/--rw 与 fs fence 的包含
 * 判断都只对当前真实存在的目录生效，两侧共用这一个过滤器；同一侧同一根只告警一次。
 * 目录存在性缓存刻意声明在模块顶层（原注释要求它先于 config store 出现，避免 onUpdate
 * 回调看到 TDZ 中的绑定）。
 *
 * @module sandbox-extra-roots/roots-filter
 */

import { statSync } from 'node:fs'

const dirExistCache = new Map<string, { ok: boolean; until: number }>();
const DIR_EXIST_TTL_MS = 5000;

/** 目录存在性判定（带 TTL 缓存；配置热更新后由 clearDirExistCache 清空）。 */
export function isExistingDirCached(root: string): boolean {
  const now = Date.now();
  const hit = dirExistCache.get(root);
  if (hit !== undefined && hit.until > now) return hit.ok;
  let ok = false;
  try {
    ok = statSync(root, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    ok = false;
  }
  dirExistCache.set(root, { ok, until: now + DIR_EXIST_TTL_MS });
  return ok;
}

// bwrap/Landlock 的 --bind/--rw 与 fs fence 的包含判断都只对"当前真实
// 存在的目录"生效:不存在的 root 会让 bwrap/Landlock 启动失败(Landlock
// 契约里是 "unopenable grant root"),也会造成 bash 与 fs 两侧判定分叉,
// 因此两侧共用这一个目录过滤器;同一侧同一根只告警一次(warned 复用)。
export function existingDirectoryRoots(roots: string[], warned: Set<string>, side: string, warn: (message: string) => void) {
  const existing = [];
  for (const root of roots) {
    if (isExistingDirCached(root)) {
      existing.push(root);
      continue;
    }
    const key = `missing-root:${side}:${root}`;
    if (!warned.has(key)) {
      warned.add(key);
      warn(`sandbox-extra-roots: extra writable root does not exist or is not a directory; not granting it to ${side}: ${root}`);
    }
  }
  return existing;
}

/** 配置热更新后清空 TTL 缓存：新配置按真实文件系统立即判定，不沿用旧结论。 */
export function clearDirExistCache(): void {
  dirExistCache.clear()
}
