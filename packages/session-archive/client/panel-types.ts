/**
 * panel-types.ts — 客户端面板的显式类型面（生成面派生 + 内部视图模型）。
 *
 * 2026-11-04 第二轮审计 SA-09/SA-16：Client 侧不得手写第二套 Remote 方法
 * 形状，组件 props 也不得散落 `any`。这里集中两件事：
 * - Remote 调用面从生成工件 `@chaoset/session-archive/remote` 的声明合并
 *   推导（TypertRemoteNamespaceMap），新增/改名方法时调用侧编译即报错；
 * - 面板/子组件的内部视图类型（列表行取 wire 类型、详情条目是「成功详情
 *   或错误文案」的联合），组件与 hook 都消费这一份。
 *
 * @module @chaoset/session-archive/client/panel-types
 */

import type {} from '@chaoset/session-archive/remote'
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type { ArchiveDetailResult, ArchiveListResult } from '@chaoset/session-archive/types'

/** 归档 Remote 服务的调用面：从生成工件的声明合并推导（RULE-035）。 */
export type ArchiveRemoteService = TypertRemoteNamespaceMap['sessionArchive']

/** 生成面里的方法名集合（新增 @Remote 方法会自动扩到这里）。 */
export type RemoteMethod = keyof ArchiveRemoteService

/** 单次调用的返回值：从生成方法签名拆出 RemoteResult 的成功 value。 */
export type RemoteValue<M extends RemoteMethod> =
  Awaited<ReturnType<ArchiveRemoteService[M]>> extends RemoteResult<infer V> ? V : never

/** Remote 调用失败的结构化错误：code 是稳定的 `<domain>/<reason>` 串，
 * 调用侧据此本地化；message 保留技术文本（日志/未知 code 兜底用）。 */
export interface ArchiveCallError extends Error {
  code: string
}

/** 面板注入的远程调用函数：成功返回 value，失败抛带 code 的结构化错误。 */
export type ArchiveCall = <M extends RemoteMethod>(
  method: M,
  ...args: Parameters<ArchiveRemoteService[M]>
) => Promise<RemoteValue<M>>

/** 归档列表行（wire 类型，不另抄一份）。 */
export type ArchiveItem = ArchiveListResult['items'][number]

/** 详情缓存条目：成功详情，或失败时只保留可展示的错误文案。 */
export type ArchiveDetailEntry = ArchiveDetailResult | { readonly error: string }

/** 详情缓存条目是否为失败态（类型守卫，替代裸 `detail.error` 读取）。 */
export function isDetailError(entry: ArchiveDetailEntry): entry is { readonly error: string } {
  return 'error' in entry
}

/**
 * 面板注册 inject 工厂返回的业务面（slots inject 回调的可消费结果）。
 * 与 client/index.tsx 的 `inject: () => ({...})` 一一对应；可选能力
 * （宿主 workspaces store 缺失）用 undefined 表达。
 */
export interface ArchivePanelInjected {
  /** 远程调用（成功取 value、失败抛 ArchiveCallError）。 */
  call: ArchiveCall
  /** 删除/恢复后刷新客户端会话摘要（宿主 sessions 服务不可用时返回 undefined）。 */
  refreshSessions: () => Promise<void> | undefined
  /** 宿主归档集合 store 的订阅口（不可用时 undefined，静默退回轮询）。 */
  subscribeArchived?: (listener: () => void) => () => void
  /** 宿主归档集合的当前条数（不可用时 undefined）。 */
  archivedCountOf?: () => number
}

/** 详情请求在途集合与缓存 Map 的只读形状（子组件只读消费）。 */
export interface ArchiveDetailStores {
  details: ReadonlyMap<string, ArchiveDetailEntry>
  detailLoading: ReadonlySet<string>
}

/** 子组件共用的勾选/动作回调签名。 */
export interface ArchiveRowCallbacks {
  toggleOne: (sessionId: string, checked: boolean) => void
  toggleDetail: (item: ArchiveItem) => void
  restoreOne: (sessionId: string) => void
  exportOne?: (sessionId: string) => void
}

