/**
 * pill-types.ts — pill 的注入面与组件 props。
 *
 * 注入面只剩「文案 t」与「渲染期解析模型目录的 resolveSeat」；会话 id 与
 * resources 的 useResource 由宿主 standard kit 提供(renderer 无条件注入)，
 * 不在这里重复声明。目录类型直接取宿主 ui-model-selection 的官方
 * ModelDirectory.store，不再手写 { subscribe, getSnapshot } 影子形状。
 *
 * @module provider-usage/pill-types
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { ProviderUsageLocaleKey } from './locales.js'

/** 渲染期解析出的一次会话座位：模型目录快照源 + 惰性加载入口。 */
export interface ProviderUsageSeat {
  /** 与 composer 模型选择器同源的单会话目录快照源(官方 ModelDirectory.store)。 */
  directory: ModelDirectory['store']
  /** 请求目录加载(目录惰性：首次读取前 current 恒为 null)。 */
  load: () => void
}

/** 由浏览器侧入口注入的本地化与目录解析面。 */
export interface ProviderUsagePillInjected {
  /** 本包 locale 命名空间的文案函数。 */
  t: (key: ProviderUsageLocaleKey, params?: Record<string, unknown>) => string
  /**
   * 渲染期解析会话的模型目录。
   *
   * 注册期(常量 inject)不解析任何会话/服务状态——宿主按 (entry × 会话绑定)
   * 永久缓存 inject 结果，且 render 期抛错会把 entry 永久 abdicate，两者都会
   * 表现为「pill 莫名其妙消失」。因此解析放在组件渲染里，失败只影响这一帧，
   * 下一次 render 自动重试；本函数**绝不抛错**。
   */
  resolveSeat: (sessionId: unknown) => ProviderUsageSeat | undefined
}

/**
 * 本组件消费的 standard kit 面。
 *
 * - `sessionId`：session 作用域 standard prop，由 renderer 随会话绑定提供；
 *   本包未把 `@deepseek-ai/dsh-client-ui-session` 列为 devDependency，因此以
 *   unknown 承接(branded SessionId 由宿主定义，这里不复制它的 brand)。
 * - `useResource`：resources 合入 GlobalStandardProps 的全局 hook，类型直接来自
 *   宿主声明。resources 由 dsh.client.inject 保证装配，故为必需项。
 */
export interface ProviderUsagePillStandardProps {
  /** 当前会话 id；无会话绑定时缺席。 */
  sessionId?: unknown
  /** resources 模型的全局 standard hook。 */
  useResource: UseResource
}

/** composer dock 列表 slot 交付的完整 props。 */
export type ProviderUsagePillProps =
  PropsRuntime<'conversation.composer.dock'>
  & ProviderUsagePillStandardProps
  & Partial<ProviderUsagePillInjected>
