/**
 * WindowRow.tsx — 展开面板里的一行窗口（纯展示）。
 *
 * @module provider-usage/WindowRow
 */

import type { UsageWindow } from '../src/types.js'
import { labelStyle, windowRowStyle, windowHeadStyle, windowMetaStyle, trackStyle } from './pill-styles.js'
import { fillStyle, formatAmount, formatReset } from './pill-format.js'
import type { ProviderUsagePillInjected } from './pill-types.js'

/** One window's progress bar and figures. */
export function WindowRow({ window, t }: { window: UsageWindow; t: ProviderUsagePillInjected['t'] }): React.ReactNode {
  const remain = window.remain
  const limit = window.limit
  // remain/limit 都是契约上的可选字段：有 limit 无 remain 是合法答案(余额未知的
  // 限额)。此时不渲染进度条与「剩余 0/…」——强制按 0 渲染会给出红色空条的错误
  // 语义，与 headline(不显示数字)和圆点(remain 缺失不判色)互相矛盾。
  const showBar = remain !== undefined && limit !== undefined && limit > 0
  const percent = showBar ? (remain / limit) * 100 : 0
  return (
    <div style={windowRowStyle}>
      <div style={windowHeadStyle}>
        <span id={`pu-window-${window.id}`} style={labelStyle}>{window.label}</span>
        <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
          {/* blocked 是上游真的拒绝过（不是余额读数为 0）：说「已用尽」比「0」更准确，因为这一行此刻确实用不了。 */}
          {remain === undefined
            ? window.unit
            : window.blocked === true
              ? t('blocked')
              : `${formatAmount(remain)} ${window.unit}`}
        </span>
      </div>
      {showBar ? <div style={trackStyle} role="progressbar" aria-labelledby={`pu-window-${window.id}`} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><div className={percent <= 20 ? 'pu-stripe' : undefined} style={fillStyle(percent)} /></div> : null}
      <span style={windowMetaStyle}>
        {showBar ? t('windowRemaining', { remain: formatAmount(remain), limit: formatAmount(limit) }) : null}
        {window.resetsAt === undefined ? null : <>{showBar ? ' · ' : ''}{t('resetsAt', { time: formatReset(window.resetsAt) })}</>}
      </span>
    </div>
  )
}
