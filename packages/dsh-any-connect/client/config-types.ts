/**
 * config-types.ts — 卡片页共享类型、静态变体清单与轮询常量。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事，
 * 页面入口与 re-export 保留在 WorkBuddyConfigPage.tsx。
 *
 * @module dsh-any-connect/client/config-types
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { type PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  WORKBUDDY_AI_PROBE_PATH,
  WORKBUDDY_AI_STATUS_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_STATUS_PATH,
  ZCODE_PROBE_PATH,
  ZCODE_SP_PROBE_PATH,
  ZCODE_SP_STATUS_PATH,
  ZCODE_STATUS_PATH,
  type WorkBuddyWebCatalog,
  type WorkBuddyWebStatus,
} from '../src/status-paths.js'
import { type WorkBuddySettingsKey } from './locales.js'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyConfigPageInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

/**
 * One card per product variant. They show different accounts, balances, and
 * model sets, so a single merged card could not say which account a number
 * belongs to.
 */
export interface WorkBuddyCardVariant {
  /** Stable key; `anyconnect` (CN) first so it keeps its historical position. */
  id: string
  statusPath: string
  probePath: string
  titleKey: WorkBuddySettingsKey
  introKey: WorkBuddySettingsKey
  signedOutHintKey: WorkBuddySettingsKey
}

export const CARD_VARIANTS: readonly WorkBuddyCardVariant[] = [
  {
    id: 'anyconnect',
    statusPath: WORKBUDDY_STATUS_PATH,
    probePath: WORKBUDDY_PROBE_PATH,
    titleKey: 'title',
    introKey: 'intro',
    signedOutHintKey: 'signedOutHint',
  },
  {
    id: 'anyconnect-ai',
    statusPath: WORKBUDDY_AI_STATUS_PATH,
    probePath: WORKBUDDY_AI_PROBE_PATH,
    titleKey: 'titleAI',
    introKey: 'introAI',
    signedOutHintKey: 'signedOutHintAI',
  },
  {
    id: 'anyconnect-zcode',
    statusPath: ZCODE_STATUS_PATH,
    probePath: ZCODE_PROBE_PATH,
    titleKey: 'titleZCode',
    introKey: 'introZCode',
    signedOutHintKey: 'signedOutHintZCode',
  },
  {
    // Start Plan 是与 Coding Plan 完全独立的连接：独立分组、独立名单、
    // 独立额度池（专属通道、当日有效），不是同一张卡上的可切换模式。
    id: 'anyconnect-zcode-sp',
    statusPath: ZCODE_SP_STATUS_PATH,
    probePath: ZCODE_SP_PROBE_PATH,
    titleKey: 'titleZCodeSP',
    introKey: 'introZCodeSP',
    signedOutHintKey: 'signedOutHintZCodeSP',
  },
]

/**
 * Card status = the host document plus client-side `loading`/`error` phases.
 * The host never emits either: `loading` covers the first round trip (mount
 * fetches all variants in parallel), and `error` means the status document
 * itself could not be read — rendered as a retryable row, never as a crash.
 */
export type CardStatus =
  | WorkBuddyWebStatus
  | { status: 'loading' }
  | { status: 'error'; message: string }

/** Props delivered by the Plugins page's bundle-configuration slot. */
export type WorkBuddyConfigPageProps =
  PropsRuntime<'plugins.bundle.config'>
  & Partial<WorkBuddyConfigPageInjected>

export const POLL_INTERVAL_MS = 60_000

/** refresh 后轮询目录落定的步长：refresh POST 立即返回，目录在后台拉取。 */
export const REFRESH_POLL_MS = 500

/** 目录落定等待上限：超时则按当前文档渲染，不无限转圈。 */
export const REFRESH_TIMEOUT_MS = 8_000

/** 目录是否已落地（live 且无错误）：refresh 轮询与自动重拉的同一判据。 */
export function isCatalogLive(catalog: WorkBuddyWebCatalog | undefined): boolean {
  return catalog !== undefined && catalog.source === 'live' && catalog.error === undefined
}

/** 目录来源的用户可见文案键：stale（saved）与离线（fallback）是不同的
 * 用户处境,必须可分辨（status-paths 的 WorkBuddyWebCatalog 契约）。 */
export function catalogSourceKey(catalog: WorkBuddyWebCatalog | undefined): WorkBuddySettingsKey {
  if (catalog === undefined) return 'catalogSourceFallback'
  // 「拉取成功但零模型」与「拉取成功且有模型」是两种结论，不能共用一句话——
  // 前者用户看到的是"刚拉取成功"+0 个模型，不说清楚就像插件坏了。
  if (catalog.source === 'live') return catalog.empty === true ? 'catalogSourceEmpty' : 'catalogSourceLive'
  if (catalog.source === 'saved') return 'catalogSourceSaved'
  return 'catalogSourceFallback'
}
