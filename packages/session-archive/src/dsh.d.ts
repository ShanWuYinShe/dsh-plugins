/**
 * 宿主 service 面的类型接线。全部映射官方包发布的契约类型——官方包自带
 * `declare module '@deepseek-ai/cordis'` 的 Context 增强（sessionPersistence /
 * workspaceRegistry / sessions 三包均有），这里只需让插件编译期看到它们：
 * 本文件 import 各官方包触发其模块增强，并把官方契约导出为插件内部别名。
 *
 * 不手写任何方法形状：宿主契约漂移由官方 d.ts 直接体现在 typecheck，
 * 而不是运行时才炸。
 */
import '@deepseek-ai/dsh-session-persistence';
import '@deepseek-ai/dsh-workspace';
import '@deepseek-ai/dsh-session';
import type { SessionPersistenceSnapshot, SessionHandle, SessionLocation } from '@deepseek-ai/dsh-session-persistence';
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { Session, SessionEvent, SessionHeader, SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import type { SessionTitleEventData } from '@deepseek-ai/dsh-session-title';

export type {
  SessionPersistenceSnapshot,
  SessionHandle,
  SessionLocation,
  Workspace,
  WorkspaceRegistry,
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionStore,
  SessionTitleEventData,
};

/**
 * jsonl 后端的 `locate` 诊断钩子：按会话头返回当前代际工件路径。它不在
 * `SessionPersistence` 抽象契约上，删除/恢复的物理
 * 定位运行时探测它，缺失时降级为「不可定位」而非失败。
 */
export interface LocatableSessionPersistence {
  locate?(meta: SessionHeader): SessionLocation | undefined;
}
