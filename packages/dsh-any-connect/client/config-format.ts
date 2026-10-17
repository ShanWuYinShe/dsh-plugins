/**
 * config-format.ts — 卡片页展示格式化：到期时间、数字/Token、徽标文案。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事，
 * 页面入口与 re-export 保留在 WorkBuddyConfigPage.tsx。
 *
 * @module dsh-any-connect/client/config-format
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { WorkBuddyConfigPageInjected } from './config-types.js'

export function formatExpiry(iso?: string): string {
  if (iso === undefined || iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d)
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

/** Compact token count: 1000000 → "1M", 256000 → "256K", else grouped digits.
 * 目录窗口是十进制整数（1_000_000），按十进制取整缩写而不是二进制 MiB。 */
export function formatTokens(value: number): string {
  if (Number.isFinite(value) && value >= 1_000_000 && value % 1_000_000 === 0) {
    return `${value / 1_000_000}M`
  }
  if (Number.isFinite(value) && value >= 1000 && value % 1000 === 0) {
    return `${value / 1000}K`
  }
  return new Intl.NumberFormat(undefined).format(value)
}

/**
 * Localize an upstream promotional badge label, with an unknown-badge fallback.
 *
 * Matching is substring-based on the three known Chinese labels, not exact:
 * upstream appends decorations (time ranges, 生效 markers) to the same base
 * label, and an exact table would leak the Chinese raw string to English
 * users on every such variant. A genuinely unknown badge still passes through
 * unchanged — showing the upstream's own label beats inventing a translation.
 */
export function modelBadgeLabel(badge: string, t: WorkBuddyConfigPageInjected['t']): string {
  if (badge.includes('夜间免费') && badge.includes('生效')) return t('badgeNightFreeActive')
  if (badge.includes('限时免费')) return t('badgeLimitedFree')
  if (badge.includes('夜间折扣')) return t('badgeNightDiscount')
  if (badge.includes('夜间免费')) return t('badgeNightFree')
  return badge
}
