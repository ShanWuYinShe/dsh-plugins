/**
 * pill-format.ts — 纯格式化助手（进度条/状态点/数值/重置时间）。
 *
 * @module provider-usage/pill-format
 */

import type { CSSProperties } from 'react'
import type { UsageRateLimit, UsageSnapshot } from '../src/types.js'
import type { ProviderUsageLocaleKey } from './locales.js'

export function fillStyle(percent: number): CSSProperties {
  const color = percent <= 5
    ? 'var(--dsw-alias-state-error-primary, #ff4d4f)'
    : percent <= 20
      ? 'var(--dsw-alias-state-warn-primary, #faad14)'
      : 'var(--dsw-alias-brand-primary, #1677ff)'
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    backgroundColor: color,
    transition: 'width 0.3s ease',
  }
}

export function getDotColor(snapshot?: UsageSnapshot, queried?: boolean): string {
  if (!queried || snapshot === undefined) return 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  if (snapshot.error && snapshot.windows.length === 0) return 'var(--dsw-alias-state-error-primary, #ff4d4f)'
  const first = snapshot.windows[0]
  if (first?.remain !== undefined && first.limit !== undefined && first.limit > 0) {
    const pct = (first.remain / first.limit) * 100
    if (pct <= 5) return 'var(--dsw-alias-state-error-primary, #ff4d4f)'
    if (pct <= 20) return 'var(--dsw-alias-state-warn-primary, #faad14)'
  }
  return 'var(--dsw-alias-state-success-primary, #52c41a)'
}

/**
 * 限流策略详情行：上游披露 policy/metric、配额/余量与窗口时拼一行纯文本。
 *
 * 三条信息都没有时返回 undefined——界面不凭空造一个「策略」。
 *
 * @param limit - 一条限流观测。
 * @param t - 文案函数（pill 注入面或本包兜底）。
 * @returns 可直接渲染的详情文本；没有可展示信息时为 undefined。
 */
export function rateLimitPolicyDetail(
  limit: UsageRateLimit,
  t: (key: ProviderUsageLocaleKey, params?: Record<string, unknown>) => string,
): string | undefined {
  const parts: string[] = []
  const policy = limit.policy ?? limit.metric
  if (policy !== undefined) parts.push(policy)
  if (limit.remaining !== undefined && limit.limit !== undefined) {
    parts.push(t('windowRemaining', { remain: String(limit.remaining), limit: String(limit.limit) }))
  } else if (limit.limit !== undefined) {
    parts.push(String(limit.limit))
  }
  if (limit.windowSeconds !== undefined) {
    parts.push(t('rateLimitWindow', { seconds: String(limit.windowSeconds) }))
  }
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * 展示层的「数据可能过期」：客户端请求失败（保旧值），或宿主把上一次
 * 成功答案折叠进了失败快照（`degraded`）。圆点调暗与文案后缀由它统一驱动——
 * 没有后半段，宿主折叠的旧数字会顶着绿点冒充新鲜值。
 */
export function isStaleDisplay(stale: boolean, snapshot?: UsageSnapshot): boolean {
  if (stale) return true
  return snapshot !== undefined && snapshot.degraded === true
}

/**
 * 数字分组：小数位最多两位。
 *
 * @param value - 要格式化的数字。
 * @param localeId - DSH 当前语言 id（来自注入面的 locale 钩子）；缺席时退回
 * 浏览器默认 locale，保证宿主契约漂移时仍可渲染。
 */
export function formatAmount(value: number, localeId?: string): string {
  return new Intl.NumberFormat(localeId, { maximumFractionDigits: 2 }).format(value)
}

/**
 * 紧凑的重置时刻。
 *
 * @param iso - ISO-8601 时刻；非法原样返回。
 * @param localeId - DSH 当前语言 id；缺席时退回浏览器默认 locale。
 */
export function formatReset(iso: string, localeId?: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return new Intl.DateTimeFormat(localeId, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

