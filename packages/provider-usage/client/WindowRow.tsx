/**
 * WindowRow.tsx — 展开面板里的一行窗口（纯展示）
 *
 * 2026-10-08 从 474 行的 ProviderUsagePill.tsx 拆出。
 *
 * @module provider-usage/展开面板里的一行窗口（纯展示）
 */

import type { UsageWindow } from '../src/types.js'
import { labelStyle, windowRowStyle, windowHeadStyle, windowMetaStyle, trackStyle } from './pill-styles.js'
import { fillStyle, formatAmount, formatReset } from './pill-format.js'
import type { ProviderUsagePillInjected } from './pill-types.js'

/** Alias kept short for the row props below. */
type ProviderUsageInjected = ProviderUsagePillInjected

/** One window's progress bar and figures. */
export function WindowRow({ window, t }: { window: UsageWindow; t: ProviderUsageInjected['t'] }): React.ReactNode {
  const hasLimit = window.limit !== undefined && window.limit > 0
  // remain 是契约上的可选字段(「provider 上报时才有」):第三方查询器可
  // 合法返回「有 limit 无 remain」。此时不渲染进度条与「剩余 0/…」——
  // 强制按 0 渲染会给出红色空条的错误语义,与 headline(不显示数字)和
  // 圆点(remain 缺失不判色)互相矛盾。
  const hasRemain = window.remain !== undefined
  const remain = window.remain ?? 0
  const percent = hasLimit && hasRemain ? (remain / window.limit!) * 100 : 0
  return (
    <div style={windowRowStyle}>
      <div style={windowHeadStyle}>
        <span id={`pu-window-${window.id}`} style={labelStyle}>{window.label}</span>
        <span style={{ fontWeight: 500 }}>
          {window.remain === undefined ? window.unit : `${formatAmount(remain)} ${window.unit}`}
        </span>
      </div>
      {hasLimit && hasRemain ? <div style={trackStyle} role="progressbar" aria-labelledby={`pu-window-${window.id}`} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><div className={percent <= 20 ? 'pu-stripe' : undefined} style={fillStyle(percent)} /></div> : null}
      <span style={windowMetaStyle}>
        {hasLimit && hasRemain ? t('windowRemaining', { remain: formatAmount(remain), limit: formatAmount(window.limit!) }) : null}
        {window.resetsAt === undefined ? null : <>{hasLimit && hasRemain ? ' · ' : ''}{t('resetsAt', { time: formatReset(window.resetsAt) })}</>}
      </span>
    </div>
  )
}
