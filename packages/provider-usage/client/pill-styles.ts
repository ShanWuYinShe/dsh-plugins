/**
 * pill-styles.ts — 样式表与 data-plugin-css 去重注入
 *
 * 2026-10-08 从 474 行的 ProviderUsagePill.tsx 拆出。
 *
 * @module provider-usage/样式表与 data-plugin-css 去重注入
 */

import type { CSSProperties } from 'react'

export const PU_STYLE_ID = '@chaoset/provider-usage/pill.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${PU_STYLE_ID}"]`) === null) {
  const styleEl = document.createElement('style')
  styleEl.dataset.pluginCss = PU_STYLE_ID
  styleEl.textContent = `
@keyframes pu-panel-in {
  from { opacity: 0; transform: translateY(4px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.pu-pill-btn {
  transition: background-color 0.15s ease, color 0.15s ease;
}
.pu-pill-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)) !important;
}
.pu-pill-panel {
  animation: pu-panel-in 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}
@media (prefers-reduced-motion: reduce) {
  .pu-pill-panel { animation: none; }
}
@keyframes pu-stripe-move {
  from { background-position: 0 0; }
  to { background-position: 20px 0; }
}
.pu-stripe {
  background-image: linear-gradient(
    -45deg,
    rgba(255,255,255,.15) 25%,
    transparent 25%,
    transparent 50%,
    rgba(255,255,255,.15) 50%,
    rgba(255,255,255,.15) 75%,
    transparent 75%
  );
  background-size: 20px 20px;
  animation: pu-stripe-move .8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .pu-stripe { animation: none; }
}
.pu-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.08));
  border-top-color: var(--dsw-alias-label-secondary, #666);
  border-radius: 50%;
  animation: pu-spin .8s linear infinite;
  vertical-align: middle;
  margin-right: 4px;
}
@keyframes pu-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .pu-spin { animation: none; } }
`
  document.head.appendChild(styleEl)
}

export const rootStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}
export const pillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: '100%',
  padding: '2px 8px',
  border: 0,
  borderRadius: 999,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
}
export const labelStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
export const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  flex: '0 0 auto',
  borderRadius: '50%',
  background: 'var(--dsw-alias-label-dimmed, #9aa0a6)',
  transition: 'background-color 0.2s ease',
}
export const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  zIndex: 30,
  minWidth: 260,
  maxWidth: 320,
  maxHeight: 380,
  overflowY: 'auto',
  padding: '12px 14px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1))',
  borderRadius: 12,
  background: 'var(--dsw-specific-tip, var(--dsw-alias-bg-layer-1, #ffffff))',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06)',
  color: 'var(--dsw-alias-label-primary)',
  backdropFilter: 'blur(10px)',
}
export const panelTitleStyle: CSSProperties = { margin: '0 0 8px', fontSize: 13, fontWeight: 600, lineHeight: '20px' }
export const windowRowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' }
export const windowHeadStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, lineHeight: '18px' }
export const windowMetaStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }
export const trackStyle: CSSProperties = { height: 6, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
export const noteStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
export const errorStyle: CSSProperties = { ...noteStyle, color: 'var(--dsw-alias-state-error-primary)' }

