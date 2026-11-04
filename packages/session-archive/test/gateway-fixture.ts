/**
 * Gateway 测试夹具：用真实 Context provide 宿主服务面，再直接实例化
 * SessionArchiveGateway（SA-08 后五个能力方法都在 Gateway 类上，deps 在
 * 构造期从 Context 装配）。供 remote-resources / cancellation 等网关级用例
 * 复用；session.test.ts 另有按真实插件装配（ctx.plugin）的完整夹具。
 *
 * 只桩「宿主业务服务」的数据面（persistence/workspace/sessions/
 * remoteAccess），文件系统仍由测试自己写临时目录后经 persistence 桩读取。
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionArchiveGateway } from '../src/remote.js'
import type { SessionArchiveConfig } from '../src/plugin-config.js'

/** 与 session.test 一致的生效配置。 */
export const gatewayCfg: SessionArchiveConfig = { detailMaxMessages: 50, messagePreviewChars: 500, titleReadConcurrency: 2 }

/** 一个持久化快照的最小形状（location 缺省 = 文件不可定位，走 unknown 分支）。 */
export interface FakeSnapshot {
  header: Record<string, unknown> & { id: string; createdAt: number };
  location?: { kind?: string; path: string };
}

/** Gateway 夹具选项：缺省数据面为空（归档集合空、无快照、无事件）。 */
export interface GatewayFixtureOptions {
  archived?: string[];
  /** 逐 id 的持久化快照；id 不在表里 = 枚举不到（ghost）。 */
  snapshots?: Record<string, FakeSnapshot | undefined>;
  /** 逐 id 的读句柄事件（detail/title 直读用）。 */
  events?: Record<string, unknown[]>;
  /** remoteAccess.allows 桩：默认 owner（全放行）。 */
  allows?: (sessionId: string) => boolean;
  /** 宿主内存中的会话 id（busy 判定用）。 */
  inMemory?: string[];
  /** 覆盖宿主 `sessions.get` 的返回序列（按调用顺序消费；用尽后按 inMemory 判定）。 */
  sessionGets?: Array<{ id: string } | undefined>;
  /** 覆盖 stat 行为（测 signal 透传等）。 */
  stat?: (id: string, options?: { signal?: AbortSignal }) => Promise<FakeSnapshot | undefined>;
  /** 覆盖 open 行为。 */
  open?: (id: string, access: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
  /** 覆盖 unarchiveSession 行为（测恢复临界区）。 */
  unarchiveSession?: (sessionId: string) => Promise<void>;
}

export interface GatewayFixture {
  ctx: Context;
  gateway: SessionArchiveGateway;
  /** 记录到的 persistence.stat 调用 options。 */
  statCalls: Array<{ id: string; options?: { signal?: AbortSignal } }>;
  /** 记录到的 persistence.open 调用 options。 */
  openCalls: Array<{ id: string; options?: { signal?: AbortSignal } }>;
  /** 已移出归档集合的 id（unarchiveSession 调用记录）。 */
  removed: string[];
}

/** 构造带真实 Context 的 Gateway（构造期即为能力方法装配 deps）。 */
export function makeGateway(options: GatewayFixtureOptions = {}): GatewayFixture {
  const archived = [...(options.archived ?? [])]
  const memory = new Set(options.inMemory ?? [])
  const statCalls: GatewayFixture['statCalls'] = []
  const openCalls: GatewayFixture['openCalls'] = []
  const removed: string[] = []
  const ctx = new Context() as any

  const registry = {
    get archivedSessionIds() {
      return archived
    },
    unarchiveSession: async (sessionId: string) => {
      removed.push(sessionId)
      if (options.unarchiveSession !== undefined) return options.unarchiveSession(sessionId)
      const at = archived.indexOf(sessionId)
      if (at >= 0) archived.splice(at, 1)
    },
  }
  const persistence = {
    stat: async (id: string, filter?: { signal?: AbortSignal }) => {
      statCalls.push({ id, options: filter })
      if (options.stat !== undefined) return options.stat(id, filter)
      return options.snapshots?.[id]
    },
    open: async (id: string, access: string, filter?: { signal?: AbortSignal }) => {
      openCalls.push({ id, options: filter })
      if (options.open !== undefined) return options.open(id, access, filter)
      const events = options.events?.[id] ?? []
      const snapshot = options.snapshots?.[id]
      return {
        header: snapshot?.header ?? { id, createdAt: 0 },
        inheritedEventCount: 0,
        access: 'read',
        read: async () => ({ eventState: 'owned', events: [...events] }),
        close: async () => {},
      }
    },
  }
  ctx.provide('workspaceRegistry', registry)
  ctx.provide('sessionPersistence', persistence)
  const sessionGets = [...(options.sessionGets ?? [])]
  ctx.provide('sessions', {
    get: (id: string) => {
      if (sessionGets.length > 0) return sessionGets.shift()
      return memory.has(id) ? { id } : undefined
    },
  })
  ctx.provide('remoteAccess', {
    allows: (resource: { kind: string; id?: unknown }) =>
      resource.kind !== 'session' || (options.allows?.(String(resource.id)) ?? true),
  })
  const gateway = new SessionArchiveGateway(ctx, { cfg: gatewayCfg })
  return { ctx, gateway, statCalls, openCalls, removed }
}
