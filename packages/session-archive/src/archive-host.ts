/**
 * archive-host.ts — 归档 host 组合入口。
 *
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
import type { SessionArchiveConfig } from './plugin-config.js'

export function createArchiveHost(ctx: Context, cfg: SessionArchiveConfig) {
  const deps = createHostContext(ctx, cfg)
  return { ...createArchiveQueries(deps), ...createArchiveMutations(deps) }
}

/** 归档 host 的对外方法面（Remote 服务层委托的目标）。 */
export type ArchiveHost = ReturnType<typeof createArchiveHost>
