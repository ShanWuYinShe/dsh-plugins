/** WorkBuddy status card contributed to Harness Plugin configuration. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH } from '../src/status-paths.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebModelBadge, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from '../src/status-paths.js'
import type { WorkBuddySettingsKey } from './locales.js'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyPluginCardInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
  variant: WorkBuddyCardVariant
}

/**
 * One card per product variant. They show different accounts, balances, and
 * model sets, so a single merged card could not say which account a number
 * belongs to. The slot is key-dispatched: two keys, one component.
 */
export interface WorkBuddyCardVariant {
  /** Slot key; `anyconnect` (CN) first so it keeps its historical position. */
  id: string
  /** Status route this card polls. */
  statusPath: string
  /** Probe-control route for detection and catalog refresh. */
  probePath: string
  /** Locale keys for this variant's heading and sign-in hint. */
  titleKey: WorkBuddySettingsKey
  introKey: WorkBuddySettingsKey
  signedOutHintKey: WorkBuddySettingsKey
}

export const CARD_VARIANTS: readonly WorkBuddyCardVariant[] = [
  {
    id: 'anyconnect',
    statusPath: WORKBUDDY_STATUS_PATH,
    probePath: WORKBUDDY_PROBE_PATH,
    titleKey: 'title',
    introKey: 'intro',
    signedOutHintKey: 'signedOutHint',
  },
  {
    id: 'anyconnect-ai',
    statusPath: WORKBUDDY_AI_STATUS_PATH,
    probePath: WORKBUDDY_AI_PROBE_PATH,
    titleKey: 'titleAI',
    introKey: 'introAI',
    signedOutHintKey: 'signedOutHintAI',
  },
]

/**
 * Card status = the host document plus a client-side `loading` phase. The
 * host never emits `loading`: the status route serializes two file reads and
 * one upstream billing call, so the first answer takes a visible round trip —
 * long enough that falling back to `signed-out` during it tells signed-in
 * users to "sign in" while their account is actually being fetched.
 */
type CardStatus = WorkBuddyWebStatus | { status: 'loading' }

/** Props delivered by the Plugin configuration item slot. */
export type WorkBuddyPluginCardProps =
  PropsRuntime<'settings.plugin.item'>
  & Partial<WorkBuddyPluginCardInjected>

const POLL_INTERVAL_MS = 60_000

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const modelBadgeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const modelOfferStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const modelBadgeChipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}
const confirmBoxStyle: CSSProperties = {
  marginTop: 8, padding: '10px 12px', borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))',
}
const confirmRowStyle: CSSProperties = { display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-brand-primary, #1677ff)',
  borderColor: 'transparent',
  color: '#fff',
}
const probeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
const probeRowEndStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }

/**
 * Reasoning-effort detection controls: one row per probeable model with its
 * own detect button, inline cost confirmation, and recorded result.
 *
 * A detection sends a few real requests that may consume credit, so the button
 * never fires directly — it opens an inline confirmation naming the model.
 * Rows keep each model and its action together in catalog order, so nothing
 * moves when a detection lands.
 */
function ProbeSection({ probe, t, busy, runningModel, pending, setPending, onDetect, onClear }: {
  probe: WorkBuddyWebProbeSection
  t: WorkBuddyPluginCardInjected['t']
  busy: boolean
  runningModel: string | undefined
  pending: string | undefined
  setPending: (model: string | undefined) => void
  onDetect: (modelId: string) => void
  onClear: () => void
}): React.ReactNode {
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('probeHeading')}</h3>
      <p style={bodyStyle}>{t('probeIntro')}</p>
      <p style={bodyStyle}>{t('probeConsentHint')}</p>
      {probe.running ? <p style={bodyStyle}>{t('probeRunningGeneric')}</p> : null}
      {probe.candidates.length === 0
        ? <p style={bodyStyle}>{t('probeResultEmpty')}</p>
        : (
          <div style={quotaGroupStyle}>
            {probe.candidates.map(id => {
              const result = probe.results.find(entry => entry.id === id)
              const name = result?.name ?? id
              return (
                <div key={id} style={modelOfferStyle}>
                  <div style={probeRowStyle}>
                    <span>{name}</span>
                    <span style={probeRowEndStyle}>
                      {result === undefined ? null : (
                        <span style={modelBadgeChipStyle}>
                          {result.validation === 'validating' && result.efforts.length > 0
                            ? result.efforts.join(' / ')
                            : t(result.validation === 'non-validating' ? 'probeResultNotValidating' : 'probeResultUnknown')}
                        </span>
                      )}
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={probe.running || busy}
                        onClick={() => { setPending(id) }}
                      >
                        {runningModel === id
                          ? t('probeRunning', { model: id })
                          : t(result === undefined ? 'probeStart' : 'probeRedetect')}
                      </button>
                    </span>
                  </div>
                  {result === undefined ? null
                    : <span style={modelRateStyle}>{t('probeResultAt', { time: formatTime(result.probedAt) })}</span>}
                  {pending === id ? (
                    <div style={confirmBoxStyle}>
                      <p style={bodyStyle}>{t('probeConfirmBody', { model: name })}</p>
                      <div style={confirmRowStyle}>
                        <button type="button" style={buttonStyle} onClick={() => { setPending(undefined) }}>
                          {t('cancel')}
                        </button>
                        <button
                          type="button"
                          style={primaryButtonStyle}
                          disabled={probe.running || busy}
                          onClick={() => { onDetect(id) }}
                        >
                          {t('probeConfirmAction')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      {probe.results.length === 0 ? null : (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => { onClear() }}>
          {t('probeClear')}
        </button>
      )}
    </div>
  )
}

/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
function modelBadgeLabel(badge: string, t: WorkBuddyPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('badgeLimitedFree')
  if (badge === '夜间折扣') return t('badgeNightDiscount')
  return badge
}
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  }
}

function dotStyle(status: CardStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(value)
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

/**
 * One-line catalog provenance under the model offers: live (just fetched) →
 * saved (this account's last good list, restored after restart/failure) →
 * fallback (compiled in). A stale list must not look like a live one.
 */
function catalogLine(catalog: WorkBuddyWebCatalog, t: WorkBuddyPluginCardInjected['t']): string {
  const base = catalog.source === 'live'
    ? t('catalogLive')
    : catalog.source === 'saved'
      ? t('catalogSaved', { time: catalog.fetchedAt === undefined ? '?' : formatTime(catalog.fetchedAt) })
      : t('catalogFallback')
  return catalog.error === undefined ? base : `${base} — ${t('catalogError', { message: catalog.error })}`
}

/** One billing package as a labeled progress bar. */
function CreditBar({ label, remain, size, t }: {
  label: string
  remain: number
  size: number
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  const detail = size > 0 ? t('exactRemaining', { remain: formatNumber(remain), size: formatNumber(size) }) : t('creditPackageUnknownSize', { remain: formatNumber(remain) })
  const percent = size > 0 ? (remain / size) * 100 : 100
  // remain 理论上可超过 size（上游记账口径不保证一致）：进度条宽度与
  // aria-valuenow 夹到 [0,100]，避免出现 ">100%" 的剩余读数。
  const clamped = Math.max(0, Math.min(100, percent))
  const display = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(clamped)
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{t('percentRemaining', { percent: display })}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
      >
        <div style={progressFillStyle(clamped)} />
      </div>
      <p style={bodyStyle}>{detail}</p>
    </div>
  )
}

/**
 * One model offer row: name, promotional badges, and the billing rate.
 *
 * The rate sits under the name rather than beside it because the row already
 * spends its horizontal budget on badges; stacking keeps long model names and
 * several badges from squeezing the rate into an ellipsis.
 */
function ModelOfferRow({ model, t }: {
  model: WorkBuddyWebModelBadge
  t: WorkBuddyPluginCardInjected['t']
}): React.ReactNode {
  return (
    <div style={modelOfferStyle}>
      <div style={quotaLabelStyle}>
        <span>{model.name}</span>
        <span style={modelBadgeStyle}>
          {model.badges?.map(badge => (
            <span key={badge} style={modelBadgeChipStyle}>{modelBadgeLabel(badge, t)}</span>
          ))}
          {model.free === true ? <span style={modelBadgeChipStyle}>{t('freeModel')}</span> : null}
        </span>
      </div>
      {model.credits === undefined ? null : <span style={modelRateStyle}>{t('rate', { rate: model.credits })}</span>}
      {model.rateUnknown === true ? <span style={modelRateStyle}>{t('rateUnknown')}</span> : null}
    </div>
  )
}

/** Render WorkBuddy sign-in state and credit as one expandable card. */
export function WorkBuddyPluginCard({ t, variant }: WorkBuddyPluginCardProps) {
  if (t === undefined) throw new Error('WorkBuddy plugin card requires its translation function')
  if (variant === undefined) throw new Error('WorkBuddy plugin card requires its variant descriptor')
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<CardStatus>({ status: 'loading' })
  /** 最近一次刷新失败的提示；成功刷新即清除。已有可展示数据时错误不清空
   *  状态、轮询不中断——瞬态失败不该把积分/登录态整个抹掉。 */
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await fetch(variant.statusPath, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        ...signal === undefined ? {} : { signal },
      })
      const value: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        // 500 会随体带一份脱敏诊断（host 的 safeMessage），拼进原因便于排障。
        const detail = typeof (value as { error?: unknown } | null)?.error === 'string'
          ? `: ${(value as { error: string }).error}`
          : ''
        throw new Error(`HTTP ${response.status}${detail}`)
      }
      // 非 JSON 的 200（中间代理、204）不能进 setStatus：render 要读
      // status.status，undefined 会直接把渲染树打崩。形状不对按失败处理。
      if (value === null || typeof value !== 'object' || typeof (value as { status?: unknown }).status !== 'string') {
        throw new Error('unexpected status payload')
      }
      if (mounted.current && signal?.aborted !== true) {
        setStatus(value as WorkBuddyWebStatus)
        setNotice(undefined)
      }
    } catch (error: unknown) {
      if (mounted.current && signal?.aborted !== true) {
        const message = error instanceof Error ? error.message : t('requestFailed')
        // 尚无任何可展示数据（首拉失败）才整体转入 error 态；否则保留
        // last-good 数据，错误降级为一条提示。
        setStatus(prev => prev.status === 'loading' ? { status: 'error', message } : prev)
        setNotice(message)
      }
    }
  }, [t, variant.statusPath])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [open, refresh])

  // 展开期间无条件轮询：按状态门控会让两类用户卡死——「后来才登录」的
  // （signed-out 不轮询就永远看不到登录态）和「遇错后永不恢复」的。
  // signed-out 的状态路由只做两次文件读，轮询成本可忽略。
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [open, refresh])

  const manualRefresh = async (): Promise<void> => {
    setBusy(true)
    try {
      await refresh()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  /** POST one control action (probe/clear/refresh) to this variant's route.
   * The in-process key travels in a header, never in the URL. */
  const control = useCallback(async (action: { action: 'probe'; model: string } | { action: 'clear' } | { action: 'refresh' }): Promise<void> => {
    if (status.status !== 'signed-in' || status.probeKey === undefined) {
      throw new Error(t('requestFailed'))
    }
    const response = await fetch(variant.probePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-probe-key': status.probeKey },
      credentials: 'same-origin',
      body: JSON.stringify(action),
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const detail = typeof (value as { error?: unknown } | null)?.error === 'string'
        ? `: ${(value as { error: string }).error}`
        : ''
      throw new Error(`HTTP ${response.status}${detail}`)
    }
  }, [status, t, variant.probePath])

  const [pending, setPending] = useState<string | undefined>(undefined)
  const [runningModel, setRunningModel] = useState<string | undefined>(undefined)

  // A sweep that finishes (or a catalogue change that removes the candidate)
  // must not leave a stale confirmation behind.
  const probeCandidates = status.status === 'signed-in' ? status.probe?.candidates : undefined
  useEffect(() => {
    if (pending !== undefined && (probeCandidates === undefined || !probeCandidates.includes(pending))) {
      setPending(undefined)
    }
  }, [pending, probeCandidates, status])

  /** Run one control action, then re-read status so results land on screen. */
  const runControl = async (action: { action: 'probe'; model: string } | { action: 'clear' } | { action: 'refresh' }): Promise<void> => {
    setBusy(true)
    try {
      await control(action)
      await refresh()
    } catch (error: unknown) {
      if (mounted.current) {
        setNotice(error instanceof Error ? error.message : t('requestFailed'))
      }
    } finally {
      if (mounted.current) {
        setBusy(false)
        setRunningModel(undefined)
      }
    }
  }

  const onDetect = (modelId: string): void => {
    setRunningModel(modelId)
    setPending(undefined)
    void runControl({ action: 'probe', model: modelId })
  }

  const title = t(variant.titleKey)
  const label = status.status === 'signed-in'
    ? status.nickname === undefined ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '') : t('signedInAs', { nickname: status.nickname })
    : status.status === 'error'
      ? t('requestFailed')
      : status.status === 'loading'
        ? t('loading')
        : t('signedOut')

  return (
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{title}</span>
          <span style={descriptionStyle}>{t(variant.introKey)}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open
        ? <div style={cardBodyStyle}>
            <h3 style={quotaTitleStyle}>{t('accountHeading')}</h3>
            <div style={rowStyle}>
              <div style={statusStyle} role="status">
                <span aria-hidden="true" style={dotStyle(status.status)} />
                <span>{label}</span>
              </div>
              <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void manualRefresh() }}>
                {busy ? t('refreshing') : t('refresh')}
              </button>
              {status.status === 'signed-in' ? (
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  title={t('refreshModelsHint')}
                  onClick={() => { void runControl({ action: 'refresh' }) }}
                >
                  {t('refreshModels')}
                </button>
              ) : null}
            </div>
            {status.status === 'signed-in'
              ? <>
                  {status.expiresAt === undefined ? null
                    : <p style={bodyStyle}>{t('accessTokenExpires', { time: formatTime(status.expiresAt) })}</p>}
                  {status.credits === undefined ? null : (
                    <div style={quotaListStyle}>
                      <div style={rowStyle}>
                        <h3 style={quotaTitleStyle}>{t('creditsHeading')}</h3>
                        <span style={bodyStyle}>{t('creditsTotal', { total: formatNumber(status.credits.total) })}</span>
                      </div>
                      {status.credits.accounts
                        .filter(account => account.remain > 0)
                        .map((account, index) => (
                        <CreditBar
                          key={`${account.packageName}-${String(index)}`}
                          label={account.packageName}
                          remain={account.remain}
                          size={account.size}
                          t={t}
                        />
                      ))}
                    </div>
                  )}
                  {status.creditsError === undefined ? null
                    : <p style={errorStyle}>{t('creditsError', { message: status.creditsError })}</p>}
                  {status.models === undefined || status.models.length === 0 ? null : (
                    <div style={quotaListStyle}>
                      <h3 style={quotaTitleStyle}>{t('modelsHeading')}</h3>
                      {status.models.map(model => <ModelOfferRow key={model.id} model={model} t={t} />)}
                    </div>
                  )}
                  {status.catalog === undefined ? null
                    : <p style={modelRateStyle}>{catalogLine(status.catalog, t)}</p>}
                  {status.probe === undefined ? null : (
                    <ProbeSection
                      probe={status.probe}
                      t={t}
                      busy={busy}
                      runningModel={runningModel}
                      pending={pending}
                      setPending={setPending}
                      onDetect={onDetect}
                      onClear={() => { void runControl({ action: 'clear' }) }}
                    />
                  )}
                </>
              : null}
            {status.status === 'signed-out'
              ? <p style={bodyStyle}>{status.reason ?? t(variant.signedOutHintKey)}</p> : null}
            {status.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
            {status.status !== 'error' && notice !== undefined ? <p style={errorStyle}>{t('refreshFailed', { message: notice })}</p> : null}
          </div>
        : null}
    </li>
  )
}
