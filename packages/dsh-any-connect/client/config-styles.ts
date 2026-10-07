/**
 * config-styles.ts — 卡片页内联样式与一次性注入的 CSS。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事，
 * 页面入口与 re-export 保留在 WorkBuddyConfigPage.tsx。
 *
 * @module dsh-any-connect/client/config-styles
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { CSSProperties } from 'react'
import type { CardStatus } from './config-types.js'

const WB_STYLE_ID = '@chaoset/dsh-any-connect/config.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${WB_STYLE_ID}"]`) === null) {
  const styleEl = document.createElement('style')
  styleEl.dataset.pluginCss = WB_STYLE_ID
  styleEl.textContent = `
.wb-card { transition: border-color .15s ease, box-shadow .15s ease; }
.wb-card:hover { border-color: var(--dsw-alias-border-l1); box-shadow: var(--dsw-shadow-lv1); }
.wb-header:hover { background: var(--dsw-alias-interactive-bg-hover); }
.wb-header { transition: background-color .15s ease; border-radius: 10px; }
.wb-btn { transition: background-color .15s ease, border-color .15s ease; }
.wb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover) !important; }
.wb-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #1677ff); outline-offset: 1px; }
.wb-dot-pulse { animation: wb-dot-pulse 2s ease-in-out infinite; }
@keyframes wb-dot-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(34, 160, 107, 0.3); } 50% { box-shadow: 0 0 0 4px rgba(34, 160, 107, 0); } }
@media (prefers-reduced-motion: reduce) { .wb-dot-pulse { animation: none; } }
.wb-spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-label-secondary); border-radius: 50%; animation: wb-spin .8s linear infinite; vertical-align: middle; margin-right: 4px; }
@keyframes wb-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .wb-spin { animation: none; } }
`
  document.head.appendChild(styleEl)
}

export const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
}

export const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '12px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

export const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 2 }

export const nameRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }

export const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }

export const summaryStyle: CSSProperties = { paddingLeft: 16, fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }

export const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }

export const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }

export const dividerStyle: CSSProperties = { border: 0, borderTop: '1px solid var(--dsw-alias-border-l2)', margin: 0 }

/** 卡体摘要行：左标签右数值，一行讲完当前积分（刷新按钮同行）。 */
export const summaryRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }

export const summaryLabelStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }

export const summaryValueStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' }

export const summaryHeadStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }

/** 模型清单的折叠开关：与区块标题同样的低调小号灰字。 */
export const summaryToggleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  border: 0,
  padding: 0,
  background: 'transparent',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  color: 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
}

export const summaryNoteStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' }

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }

export const descriptionStyle: CSSProperties = { fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }

export const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 26, padding: '3px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px', cursor: 'pointer' }

export const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }

export const hintStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }

export const chipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '16px',
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #22a06b) 12%, transparent)',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}

export const modelBadgesStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }

export const modelTableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }

export const modelThStyle: CSSProperties = {
  padding: '4px 6px 6px',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

export const modelRowBaseStyle: CSSProperties = { borderRadius: 6 }

export const modelRowEvenStyle: CSSProperties = { ...modelRowBaseStyle, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.025))' }

export const modelTdStyle: CSSProperties = { padding: '5px 6px' }

export const modelNameStyle: CSSProperties = { ...modelTdStyle, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }

export const metaCellStyle: CSSProperties = { ...modelTdStyle, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

export const planCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03))',
  border: '1px solid var(--dsw-alias-border-l2)',
}

export const planTitleRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }

export const planNameStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

export const planBadgeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }

export const privilegeChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 500,
  background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #1677ff) 12%, transparent)',
  color: 'var(--dsw-alias-brand-primary, #1677ff)',
  border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #1677ff) 20%, transparent)',
}

export const planMetaStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }

/** 今日待领取：唯一需要用户动作的状态，给一块带边框的提示区。 */
export const claimBoxStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 10,
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-state-warn-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
}

/**
 * 探测失败（unknown）：与 available 同样可见，但用中性样式——它是"没测到"，
 * 不是"有东西等你领"，用警告色会误导用户以为有待办。
 */
export const claimUnknownBoxStyle: CSSProperties = {
  ...claimBoxStyle,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
}

export const claimTitleStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

export const claimIdRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }

export const claimCodeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  wordBreak: 'break-all',
}

export const planChipOffStyle: CSSProperties = {
  ...privilegeChipStyle,
  background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.12))',
  color: 'var(--dsw-alias-label-tertiary)',
  borderColor: 'transparent',
}

export const signedOutRowStyle: CSSProperties = {
  ...cardStyle,
}

export const signedOutRowHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  width: '100%',
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

export const signedOutBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '10px 14px 12px' }

export function dotStyle(status: CardStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
}
