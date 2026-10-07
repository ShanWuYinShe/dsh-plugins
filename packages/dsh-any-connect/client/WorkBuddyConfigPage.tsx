/**
 * WorkBuddyConfigPage.tsx — 配置页入口（对外 API 不变）。
 *
 * 2026-10-08 从 961 行的单文件拆出：类型与样式、模型行、未登录行、变体卡片、
 * 变体列表各自成模块；本文件只保留页面入口与 re-export。
 *
 * @module dsh-any-connect/client/WorkBuddyConfigPage
 */
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { type WorkBuddyConfigPageProps } from './config-types.js'
import { VariantsPage } from './VariantsPage.js'

export { isCatalogLive } from './config-types.js'
export type { WorkBuddyConfigPageInjected, WorkBuddyConfigPageProps } from './config-types.js'

/**
 * The bundle's configuration entry on its Plugins page. The page draws the
 * title, icon, and crumb itself and asks each entry for two views through its
 * owner props; this slot's contract is `page`-only, so the defensive non-`page`
 * branch stays a static one-liner instead of polling account state.
 */
export function WorkBuddyConfigPage({ t, view }: WorkBuddyConfigPageProps): React.ReactNode {
  if (t === undefined) throw new Error('WorkBuddy config page requires its translation function')
  if (view !== 'page') return t('intro')
  return <VariantsPage t={t} />
}
