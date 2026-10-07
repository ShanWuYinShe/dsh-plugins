/**
 * archive-host.ts — 归档 host 组合入口（对外 API 不变）。
 *
 * 2026-10-08 从 663 行拆出：
 * - archive-host-context.ts：内部助手与共享状态（deps 对象）；
 * - archive-host-queries.ts：count / list / detail；
 * - archive-host-mutations.ts：deleteArchived / unarchive。
 *
 * @module @chaoset/session-archive/archive-host
 */

import type { Context } from '@deepseek-ai/cordis'
import { createHostContext } from './archive-host-context.js'
import { createArchiveQueries } from './archive-host-queries.js'
import { createArchiveMutations } from './archive-host-mutations.js'

export function createArchiveHost(ctx: Context, cfg: Record<string, any>) {
  const deps = createHostContext(ctx, cfg)
  return { ...createArchiveQueries(deps), ...createArchiveMutations(deps) }
}
