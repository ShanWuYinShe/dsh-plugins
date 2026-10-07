/**
 * pill-format.ts — 纯格式化助手（进度条/状态点/数值/重置时间）
 *
 * 2026-10-08 从 474 行的 ProviderUsagePill.tsx 拆出。
 *
 * @module provider-usage/纯格式化助手（进度条/状态点/数值/重置时间）
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
    background: color,
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

