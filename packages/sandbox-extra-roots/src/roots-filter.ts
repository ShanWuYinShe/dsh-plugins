/**
 * roots-filter.ts — 额外可写根的「真实存在目录」过滤（带 TTL 缓存）。
 *
 * 官方 enforcement（Seatbelt/bwrap/Landlock/fs fence）对
 * `additionalWritableRoots` 的缺失/非目录条目会拒绝（SandboxInvalidRootError），
 * 一个失效的缓存目录不能把整条沙盒调用打挂：包装 policy 时先按真实文件系统
 * 过滤，同一侧同一根只告警一次。
 *
 * 目录存在性缓存是**实例级状态**（RULE-051「共享状态必须有 owner」）：由 apply
 * 每次（含配置热更新后的行 reload）经 createRootsFilter() 重建，并交给
 * policy-merge 的包装状态（owner: service 实例）持有。此前它是模块级单例 +
 * 全局 clearDirExistCache()：同进程内两个 profile/挂载点会共享缓存并互相清空。
 *
 * @module sandbox-extra-roots/roots-filter
 */

import { statSync } from 'node:fs'

const DIR_EXIST_TTL_MS = 5000

/** 目录存在性 TTL 缓存的单条记录。 */
interface DirExistEntry {
  ok: boolean
  until: number
}

/** 实例级目录存在性过滤器（owner：apply 创建的包装状态）。 */
export interface RootsFilter {
  /** 目录存在性判定（带 TTL 缓存；配置热更新后由 apply 换新实例/clear 失效）。 */
  isExistingDirCached(root: string): boolean
  /**
   * 只保留当前真实存在的目录（官方 enforcement 对缺失/非目录根会拒绝）。
   * 同一侧同一根只告警一次（warned 复用）。
   */
  existingDirectoryRoots(
    roots: readonly string[],
    warned: Set<string>,
    side: string,
    warn: (message: string) => void,
  ): string[]
  /** 配置热更新后清空 TTL 缓存：新配置按真实文件系统立即判定，不沿用旧结论。 */
  clear(): void
}

/** 创建一个实例级目录存在性过滤器（缓存随返回对象回收，不跨实例共享）。 */
export function createRootsFilter(): RootsFilter {
  const dirExistCache = new Map<string, DirExistEntry>()

  const isExistingDirCached = (root: string): boolean => {
    const now = Date.now()
    const hit = dirExistCache.get(root)
    if (hit !== undefined && hit.until > now) return hit.ok
    let ok = false
    try {
      ok = statSync(root, { throwIfNoEntry: false })?.isDirectory() === true
    } catch {
      ok = false
    }
    dirExistCache.set(root, { ok, until: now + DIR_EXIST_TTL_MS })
    return ok
  }

  const existingDirectoryRoots = (
    roots: readonly string[],
    warned: Set<string>,
    side: string,
    warn: (message: string) => void,
  ): string[] => {
    const existing: string[] = []
    for (const root of roots) {
      if (isExistingDirCached(root)) {
        existing.push(root)
        continue
      }
      const key = `missing-root:${side}:${root}`
      if (!warned.has(key)) {
        warned.add(key)
        warn(`sandbox-extra-roots: extra writable root does not exist or is not a directory; not granting it to ${side}: ${root}`)
      }
    }
    return existing
  }

  return { isExistingDirCached, existingDirectoryRoots, clear: () => dirExistCache.clear() }
}
