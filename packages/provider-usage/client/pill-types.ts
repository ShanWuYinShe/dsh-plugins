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
   * resource 订阅面（dsh-client-resources 的 GlobalStandardProps,renderer 注入）。
   * 缺席（未装配 resources 的部署）时 useProviderUsage 回退内置轮询。
   */
  useResource?: UseResource
}

/** Props delivered by the composer dock's list slot. */
export type ProviderUsagePillProps =
  PropsRuntime<'conversation.composer.dock'>
  & Partial<ProviderUsagePillInjected>
