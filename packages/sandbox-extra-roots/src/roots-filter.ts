/**
 * roots-filter.ts — 额外可写根的「真实存在目录」过滤（带 TTL 缓存）。
 *
 * bwrap/Landlock 的 --bind/--rw 与 fs fence 的包含判断都只对当前真实存在的
 * 目录生效，两侧共用这一个过滤器；同一侧同一根只告警一次。
 *
 * 目录存在性缓存是**实例级状态**（RULE-051「共享状态必须有 owner」）：由 apply
 * 每次（含配置热更新后的行 reload）经 createRootsFilter() 重建，并挂在包装状态
 * （MountState）上随实例回收。此前它是模块级单例 + 全局 clearDirExistCache()：
 * 同进程内两个 profile/挂载点会共享缓存并互相清空，跨 fiber 卸载也不回收。
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
   * 只保留当前真实存在的目录（bwrap/Landlock 的 --bind/--rw 与 fs fence 共用）。
   * 不存在的根会让 bwrap/Landlock 启动失败（Landlock 契约里是 "unopenable
   * grant root"），也会造成 bash 与 fs 两侧判定分叉，因此统一在此过滤；
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
