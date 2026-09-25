/**
 * The composer-dock usage pill: the current session provider's remaining quota,
 * shown beside the harness's own turn/token pills.
 *
 * The provider comes from the harness's own per-session model directory
 * (`ctx.modelDirectories.directoryFor(sessionId).store`), which is the record
 * the composer's model seat itself renders from. That matters for correctness:
 * the durable `modelSelection` projection is empty until the session has made
 * its first request, so a pill reading only the projection would stay blank for
 * a brand-new session even though the composer already shows a concrete model.
 *
 * A provider with no querier is a normal state and reads as such — the pill
 * never invents a number, and never hides silently enough that a user wonders
 * whether the feature is broken.
 *
 * @module provider-usage/pill
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Declares the session standard props (sessionId/useSession/useProjection) the
// dock slot's `session` scope hands every entry.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { UsageSnapshot, UsageWindow } from '../src/types.js'
import { PROVIDER_USAGE_PATH } from '../src/types.js'
import type { ProviderUsageLocaleKey } from './locales.js'

/** Localized copy injected by the browser-plugin registration. */
export interface ProviderUsagePillInjected {
  t: (key: ProviderUsageLocaleKey, params?: Record<string, unknown>) => string
  /**
   * Per-session model directory, the authoritative current-provider source.
   * Absent when no model-selection UI is mounted, in which case the pill
   * renders nothing rather than guessing a provider.
   */
  directory?: {
    subscribe: (listener: () => void) => () => void
    getSnapshot: () => ModelDirectoryState
  }
  /** Asks the directory to load its catalog; the seat is lazy until asked. */
  load?: () => void
}

/** Props delivered by the composer dock's list slot. */
export type ProviderUsagePillProps =
  PropsRuntime<'conversation.composer.dock'>
  & Partial<ProviderUsagePillInjected>

/** Poll cadence while a session is open; the host caches on the same order. */
const POLL_INTERVAL_MS = 60_000

/** One provider answer as the route serializes it: a snapshot, or a not-queried marker. */
type RouteAnswer = UsageSnapshot | { provider: string; queried: false }

const PU_STYLE_ID = '@chaoset/provider-usage/pill.css'
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

const rootStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}
const pillStyle: CSSProperties = {
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
const labelStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  flex: '0 0 auto',
  borderRadius: '50%',
  background: 'var(--dsw-alias-label-dimmed, #9aa0a6)',
  transition: 'background-color 0.2s ease',
}
const panelStyle: CSSProperties = {
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
const panelTitleStyle: CSSProperties = { margin: '0 0 8px', fontSize: 13, fontWeight: 600, lineHeight: '20px' }
const windowRowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' }
const windowHeadStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, lineHeight: '18px' }
const windowMetaStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }
const trackStyle: CSSProperties = { height: 6, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
const noteStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const errorStyle: CSSProperties = { ...noteStyle, color: 'var(--dsw-alias-state-error-primary)' }

function fillStyle(percent: number): CSSProperties {
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

function getDotColor(snapshot?: UsageSnapshot, queried?: boolean): string {
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
function formatAmount(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
}

/** Compact reset time. */
function formatReset(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at)
}

/** Alias kept short for the row props below. */
type ProviderUsageInjected = ProviderUsagePillInjected

/** One window's progress bar and figures. */
function WindowRow({ window, t }: { window: UsageWindow; t: ProviderUsageInjected['t'] }): React.ReactNode {
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

/** The stored default snapshot used before the directory has loaded. */
const ABSENT_DIRECTORY: ModelDirectoryState = {
  current: null,
  pending: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

/**
 * The usage pill itself.
 *
 * Rendering rules, in order: no current provider renders nothing (there is no
 * account to describe); a provider without a querier states that; a failed
 * query shows the reason; otherwise the first window's remaining figure is the
 * headline and the rest live in the expanded panel.
 */
export function ProviderUsagePill({ t, directory, load }: ProviderUsagePillProps): React.ReactNode {
  if (t === undefined) throw new Error('provider-usage: the pill requires its translation function')
  // Subscribe to the same per-session directory the composer's model seat
  // renders from, so a model switch moves the pill with no coordination and a
  // brand-new session (empty durable projection) still reports.
  const state = useSyncExternalStore(
    // 方法引用不绑定 this：宿主目录实现若依赖 this 会静默坏，包一层箭头防御。
    directory === undefined ? (() => () => {}) : (fn => directory.subscribe(fn)),
    directory === undefined ? (() => ABSENT_DIRECTORY) : (() => directory.getSnapshot()),
  )
  // The directory is lazy: `current` stays null until someone loads it, which
  // the composer's own model seat does on mount. A pill that only read the
  // snapshot would sit blank forever on a fresh session.
  useEffect(() => { load?.() }, [load])
  const provider = state.current?.provider
  const [answer, setAnswer] = useState<RouteAnswer | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 保旧值时的“数据可能过期”信号：只有展示更早成功答案时才亮。
  const [stale, setStale] = useState(false)
  // 面板左右对齐：触发按钮靠右缘时左对齐面板会溢出视口，提前翻转。
  const [alignRight, setAlignRight] = useState(false)
  const answerRef = useRef<RouteAnswer | undefined>(undefined)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Click-outside and Escape key dismissal
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // 面板挂着 role="dialog" 就必须可聚焦、可进入：打开时把焦点移入面板
  // （键盘用户才能读到 380px 可滚内容），关闭时归还给触发按钮。
  useEffect(() => {
    if (open && !prevOpenRef.current) panelRef.current?.focus()
    else if (!open && prevOpenRef.current) buttonRef.current?.focus()
    prevOpenRef.current = open
  }, [open])

  // 跨闭包跟踪当前 provider:手动刷新(面板内按钮)不带 AbortSignal,provider
  // 切换时无法取消在途的旧请求——写回前必须核对响应的 provider 是否仍是
  // 当前值,否则 A 的旧余额会顶着 B 的名字显示到下一轮轮询。
  const providerRef = useRef(provider)
  useEffect(() => { providerRef.current = provider }, [provider])
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (provider === undefined || provider === '') return
    setBusy(true)
    try {
      const response = await fetch(`${PROVIDER_USAGE_PATH}?providers=${encodeURIComponent(provider)}`, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const first = (value as { snapshots?: unknown } | null)?.snapshots
      const snapshot = Array.isArray(first) ? first[0] as RouteAnswer : undefined
      if (mounted.current && signal?.aborted !== true && providerRef.current === provider) {
        answerRef.current = snapshot
        setAnswer(snapshot)
        setStale(false)
      }
    } catch (error: unknown) {
      // Keep the last good answer: a transient failure must not blank the
      // number the user is reading. Showing an older success is flagged
      // stale (dot dims + copy suffix); anything else degrades to failed.
      const prev = answerRef.current
      if (prev !== undefined && !('queried' in prev) && prev.error === undefined) {
        if (mounted.current && signal?.aborted !== true && providerRef.current === provider) setStale(true)
        return
      }
      if (mounted.current && signal?.aborted !== true && providerRef.current === provider) {
        const failed: RouteAnswer = { provider, windows: [], fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
        answerRef.current = failed
        setAnswer(failed)
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [provider])

  useEffect(() => {
    if (provider === undefined || provider === '') return
    const controller = new AbortController()
    // Reset first so a provider switch never shows the previous provider's
    // balance while the new answer is in flight.
    answerRef.current = undefined
    setAnswer(undefined)
    setStale(false)
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [provider, refresh])

  useEffect(() => {
    if (provider === undefined || provider === '') return
    const controller = new AbortController()
    let timer: number | undefined
    const start = () => { timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS) }
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined } }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { void refresh(controller.signal); start() }
      else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      controller.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [provider, refresh])

  if (provider === undefined || provider === '') return null

  const queried = answer !== undefined && !('queried' in answer)
  const snapshot = queried ? answer as UsageSnapshot : undefined
  const headline = answer === undefined
    ? t('loading')
    : !queried
      ? t('noQuerier', { provider })
      : snapshot!.error !== undefined && snapshot!.windows.length === 0
        ? t('failed')
        : snapshot!.windows.length === 0
          ? t('noWindows')
          : snapshot!.windows[0]!.remain === undefined
            ? `${snapshot!.windows[0]!.label}: ${snapshot!.windows[0]!.unit}${snapshot!.windows.length > 1 ? ` +${snapshot!.windows.length - 1}` : ''}`
            : `${formatAmount(snapshot!.windows[0]!.remain ?? 0)} ${snapshot!.windows[0]!.unit} ${t('remaining')}${snapshot!.windows.length > 1 ? ` +${snapshot!.windows.length - 1}` : ''}`

  // 过期后缀同时进可见文案与 aria-label：读屏用户同样感知数据新鲜度。
  const headlineText = stale ? `${headline} · ${t('staleData')}` : headline

  return (
    <span ref={rootRef} style={{ ...rootStyle, position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        className="pu-pill-btn"
        style={{
          ...pillStyle,
          background: open ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05))' : 'transparent',
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={headlineText}
        onClick={() => {
          if (!open && buttonRef.current) {
            // 面板默认左对齐；触发按钮靠右缘时 320px 面板会溢出视口，
            // 按按钮位置提前决定翻转（抄 useAnchoredPosition 的翻转意图）。
            const rect = buttonRef.current.getBoundingClientRect()
            setAlignRight(rect.left + 320 > window.innerWidth - 8)
          }
          setOpen(!open)
        }}
      >
        <span aria-hidden="true" style={{ ...dotStyle, background: getDotColor(snapshot, queried), opacity: stale ? 0.45 : 1 }} />
        <span style={labelStyle}>{provider}</span>
        <span style={labelStyle}>{answer === undefined ? <><span className="pu-spin" aria-hidden="true" />{headlineText}</> : headlineText}</span>
      </button>
      {open ? (
        <div ref={panelRef} tabIndex={-1} className="pu-pill-panel" style={{ ...panelStyle, outline: 'none', ...(alignRight ? { right: 0, left: 'auto' } : { left: 0 }) }} role="dialog" aria-label={t('providerUsageTitle')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '0 0 8px' }}>
            <p style={{ ...panelTitleStyle, margin: 0 }}>{provider}{snapshot?.plan === undefined ? null : ` · ${t('plan')} ${snapshot.plan}`}</p>
            <button
              type="button"
              className="pu-pill-btn"
              style={{ ...pillStyle, border: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1))', borderRadius: 8, padding: '2px 8px', fontSize: 12, lineHeight: '18px' }}
              disabled={busy}
              title={t('refresh')}
              aria-label={t('refresh')}
              onClick={() => { void refresh() }}
            >
              {busy ? <><span className="pu-spin" aria-hidden="true" />{t('refreshing')}</> : t('refresh')}
            </button>
          </div>
          {busy ? <p style={noteStyle}>{t('refreshing')}</p> : null}
          {!queried
            ? <p style={noteStyle}>{t('noQuerierHint')}</p>
            : snapshot!.windows.length === 0
              ? <p style={noteStyle}>{snapshot!.error === undefined ? t('noWindows') : t('failed')}</p>
              : snapshot!.windows.map(window => <WindowRow key={window.id} window={window} t={t} />)}
          {queried && snapshot!.error !== undefined ? <p style={errorStyle}>{snapshot!.error}</p> : null}
        </div>
      ) : null}
    </span>
  )
}
