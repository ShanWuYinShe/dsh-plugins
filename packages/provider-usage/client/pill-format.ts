/**
 * pill-format.ts — 纯格式化助手（进度条/状态点/数值/重置时间）。
 *
 * @module provider-usage/pill-format
 */

import type { CSSProperties } from 'react'
import type { UsageSnapshot } from '../src/types.js'

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
 * 展示层的「数据可能过期」：客户端请求失败（保旧值），或宿主把上一次
 * 成功答案折叠进了失败快照（`degraded`）。圆点调暗与文案后缀由它统一驱动——
 * 没有后半段，宿主折叠的旧数字会顶着绿点冒充新鲜值。
 */
export function isStaleDisplay(stale: boolean, snapshot?: UsageSnapshot): boolean {
  if (stale) return true
  return snapshot !== undefined && snapshot.degraded === true
}

/** Group digits; a fractional balance keeps up to two decimals. */
export function formatAmount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}

/** Compact reset time. */
export function formatReset(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

