/**
 * pill-types.ts — pill 的注入面与组件 props
 *
 * 2026-10-08 从 474 行的 ProviderUsagePill.tsx 拆出。
 *
 * @module provider-usage/pill 的注入面与组件 props
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ProviderUsageLocaleKey } from './locales.js'

/** Localized copy injected by the browser-plugin registration. */
export interface ProviderUsagePillInjected {
  t: (key: ProviderUsageLocaleKey, params?: Record<string, unknown>) => string
  /**
   * Resolve a session's model seat at render time.
   *
   * 注册时不再解析会话状态（宿主自带 pill 同样如此：它们的 inject 是无参常量，
   * 会话数据走 standard kit）。这样 entry 的 props 是常量，不存在「坏 props 被
   * sessionInjectCache 永久固化」；解析失败也只是这一次渲染没有目录，
   * 下一次 render 自然重试。
   *
   * @returns undefined when the directory is not available right now.
   */
  resolveSeat?: (sessionId: unknown) => { directory: ProviderUsagePillInjected['directory']; load: () => void } | undefined
  /**
   * Per-session model directory, the authoritative current-provider source.
   * Absent when no model-selection UI is mounted, in which case the pill
   * renders nothing rather than guessing a provider.
   */
  directory?: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => ModelDirectoryState
  }
  /** Asks the directory to load its catalog; the seat is lazy until asked. */
  load?: () => void
  /**
   * Whether the pill has a session to report on.
   *
   * Supplied by the renderer as the standard `sessionId` prop, exactly like the
   * host's own stats pills read their session from the standard kit rather than
   * resolving it at registration time.
   */
  sessionId?: unknown
  /**
   * resource 订阅面（dsh-client-resources 的 GlobalStandardProps,renderer 注入）。
   * 缺席（未装配 resources 的部署）时 useProviderUsage 回退内置轮询。
   */
  useResource?: UseResource
}

/** Props delivered by the composer dock's list slot. */
export type ProviderUsagePillProps =
  PropsRuntime<'conversation.composer.dock'>
  & Partial<ProviderUsagePillInjected>
