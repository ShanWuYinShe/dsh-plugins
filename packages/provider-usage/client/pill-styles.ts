/**
 * pill-styles.ts — 样式表与 data-plugin-css 去重注入
 *
 * 2026-10-08 从 474 行的 ProviderUsagePill.tsx 拆出。
 *
 * @module provider-usage/样式表与 data-plugin-css 去重注入
 */

import type { CSSProperties } from 'react'

const PU_STYLE_ID = '@chaoset/provider-usage/pill.css'
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${PU_STYLE_ID}"]`) === null) {
  const styleEl = document.createElement('style')
  styleEl.dataset.pluginCss = PU_STYLE_ID
  styleEl.textContent = `
@keyframes pu-panel-in {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.pu-pill-btn {
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.pu-pill-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover) !important;
}
.pu-pill-btn:active {
  background: var(--dsw-alias-interactive-bg-active) !important;
}
.pu-pill-btn:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #1677ff);
  outline-offset: 1px;
}
.pu-pill-panel {
  animation: pu-panel-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
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
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-label-secondary);
  border-radius: 50%;
  animation: pu-spin .8s linear infinite;
  vertical-align: middle;
  margin-right: 4px;
}
@keyframes pu-spin { to { transform: rotate(360deg); } }
.pu-spin-icon {
  animation: pu-spin .8s linear infinite;
  transform-origin: center center;
}
@keyframes pu-dot-pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.35); opacity: 0.55; }
}
.pu-dot-pulse {
  animation: pu-dot-pulse 1.2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) { .pu-spin, .pu-spin-icon, .pu-dot-pulse { animation: none; } }
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
  border: '1px solid transparent',
  borderRadius: 999,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  lineHeight: '18px',
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
  transition: 'background-color 0.2s ease, opacity 0.2s ease',
}
export const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  zIndex: 30,
  width: 310,
  maxWidth: 'calc(100vw - 16px)',
  maxHeight: 'min(380px, calc(100vh - 120px))',
  boxSizing: 'border-box',
  overflowY: 'auto',
  padding: '12px 14px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 14,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: 'var(--dsw-shadow-lv3, 0 16px 40px rgba(0, 0, 0, 0.2)), 0 2px 8px rgba(0, 0, 0, 0.06)',
  color: 'var(--dsw-alias-label-primary)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
}
export const refreshButtonStyle: CSSProperties = {
  ...pillStyle,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '2px 8px',
  fontSize: 11,
  fontWeight: 500,
  lineHeight: '18px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  flexShrink: 0,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-layer-2, transparent)',
  transition: 'opacity 0.15s ease, background-color 0.15s ease, border-color 0.15s ease',
}
export const panelTitleStyle: CSSProperties = { margin: '0 0 8px', fontSize: 13, fontWeight: 600, lineHeight: '20px' }
export const windowRowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' }
export const windowHeadStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontSize: 12, lineHeight: '18px' }
export const windowMetaStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }
export const trackStyle: CSSProperties = { height: 6, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)' }
export const noteStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
export const errorStyle: CSSProperties = { ...noteStyle, color: 'var(--dsw-alias-state-error-primary)' }

/**
 * 限流块：用告警色的浅底把「现在发不出请求」和下面的额度数字分开。
 *
 * 刻意不用 error 红：限流是**会自愈**的状态，不是故障；红色会让用户以为
 * 账号/配置出了问题。用 warn 色（与进度条 20% 以下同一套语义）。
 */
export const rateLimitBoxStyle: CSSProperties = {
  margin: '0 0 10px',
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-state-warn-primary, #faad14)',
  borderRadius: 10,
  // 宿主没有 warn 的 hover 底色变量（只有 -danger 那支），而这里要的是
  // 「会自愈的告警」而不是错误色：从真实存在的 warn 主色派生一个淡底，
  // 主题换色时自动跟随，也避免引用不存在的变量名（css-tokens 回归会抓）。
  background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)',
}
export const rateLimitTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  fontWeight: 600,
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-warn-primary, #faad14)',
}
export const rateLimitLineStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
}
export const rateLimitMetaStyle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: 11,
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary)',
}

