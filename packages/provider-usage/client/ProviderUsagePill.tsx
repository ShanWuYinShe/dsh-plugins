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
  padding: '1px 8px',
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
}
const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  left: 0,
  zIndex: 20,
  width: 280,
  padding: '10px 12px',
  border: '0.5px solid var(--dsw-alias-border-l1)',
  borderRadius: 10,
  background: 'var(--dsw-specific-tip, var(--dsw-alias-bg-layer-1))',
  boxShadow: '0 6px 20px rgba(0, 0, 0, 0.12)',
  color: 'var(--dsw-alias-label-primary)',
}
const panelTitleStyle: CSSProperties = { margin: '0 0 8px', fontSize: 13, fontWeight: 600, lineHeight: '20px' }
const windowRowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' }
const windowHeadStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, lineHeight: '18px' }
const windowMetaStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }
const trackStyle: CSSProperties = { height: 6, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
const noteStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const errorStyle: CSSProperties = { ...noteStyle, color: 'var(--dsw-alias-state-error-primary)' }

function fillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  }
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
  const remain = window.remain ?? 0
  const percent = hasLimit ? (remain / window.limit!) * 100 : 0
  return (
    <div style={windowRowStyle}>
      <div style={windowHeadStyle}>
        <span style={labelStyle}>{window.label}</span>
        <span>{formatAmount(remain)} {window.unit}</span>
      </div>
      {hasLimit ? <div style={trackStyle}><div style={fillStyle(percent)} /></div> : null}
      <span style={windowMetaStyle}>
        {hasLimit ? t('windowRemaining', { remain: formatAmount(remain), limit: formatAmount(window.limit!) }) : null}
        {window.resetsAt === undefined ? null : <>{hasLimit ? ' · ' : ''}{t('resetsAt', { time: formatReset(window.resetsAt) })}</>}
      </span>
    </div>
  )
}

/** The stored default snapshot used before the directory has loaded. */
const ABSENT_DIRECTORY: ModelDirectoryState = {
  current: null,
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
    directory === undefined ? (() => () => {}) : directory.subscribe,
    directory === undefined ? (() => ABSENT_DIRECTORY) : directory.getSnapshot,
  )
  // The directory is lazy: `current` stays null until someone loads it, which
  // the composer's own model seat does on mount. A pill that only read the
  // snapshot would sit blank forever on a fresh session.
  useEffect(() => { load?.() }, [load])
  const provider = state.current?.provider
  const [answer, setAnswer] = useState<RouteAnswer | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

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
      if (mounted.current && signal?.aborted !== true) setAnswer(snapshot)
    } catch (error: unknown) {
      // Keep the last good answer: a transient failure must not blank the
      // number the user is reading.
      if (mounted.current && signal?.aborted !== true) {
        setAnswer(previous => previous === undefined || 'queried' in previous
          ? { provider, windows: [], fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
          : previous)
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
    setAnswer(undefined)
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [provider, refresh])

  useEffect(() => {
    if (provider === undefined || provider === '') return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
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
          : `${formatAmount(snapshot!.windows[0]!.remain ?? 0)} ${snapshot!.windows[0]!.unit} ${t('remaining')}`

  return (
    <span style={{ ...rootStyle, position: 'relative' }}>
      <button
        type="button"
        style={pillStyle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={headline}
        onClick={() => { setOpen(!open) }}
      >
        <span aria-hidden="true" style={dotStyle} />
        <span style={labelStyle}>{provider}</span>
        <span style={labelStyle}>{headline}</span>
      </button>
      {open ? (
        <span style={panelStyle} role="dialog" aria-label={t('providerUsageTitle')}>
          <p style={panelTitleStyle}>{provider}{snapshot?.plan === undefined ? null : ` · ${t('plan')} ${snapshot.plan}`}</p>
          {busy ? <p style={noteStyle}>{t('refreshing')}</p> : null}
          {!queried
            ? <p style={noteStyle}>{t('noQuerierHint')}</p>
            : snapshot!.windows.length === 0
              ? <p style={noteStyle}>{snapshot!.error === undefined ? t('noWindows') : t('failed')}</p>
              : snapshot!.windows.map(window => <WindowRow key={window.id} window={window} t={t} />)}
          {queried && snapshot!.error !== undefined ? <p style={errorStyle}>{snapshot!.error}</p> : null}
        </span>
      ) : null}
    </span>
  )
}
