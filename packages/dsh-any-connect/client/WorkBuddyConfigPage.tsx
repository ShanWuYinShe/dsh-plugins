/** WorkBuddy configuration page contributed to the DSH Plugins page. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { WORKBUDDY_AI_PROBE_PATH, WORKBUDDY_AI_STATUS_PATH, WORKBUDDY_PROBE_PATH, WORKBUDDY_STATUS_PATH, ZCODE_OFFPEAK_PROBE_PATH, ZCODE_OFFPEAK_STATUS_PATH, ZCODE_PROBE_PATH, ZCODE_STATUS_PATH } from '../src/status-paths.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebModelRow, WorkBuddyWebOffPeakWindow, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from '../src/status-paths.js'
import type { WorkBuddySettingsKey } from './locales.js'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyConfigPageInjected {
  t: (key: WorkBuddySettingsKey, params?: Record<string, unknown>) => string
}

/**
 * One card per product variant. They show different accounts, balances, and
 * model sets, so a single merged card could not say which account a number
 * belongs to.
 */
interface WorkBuddyCardVariant {
  /** Stable key; `anyconnect` (CN) first so it keeps its historical position. */
  id: string
  statusPath: string
  probePath: string
  titleKey: WorkBuddySettingsKey
  introKey: WorkBuddySettingsKey
  signedOutHintKey: WorkBuddySettingsKey
}

const CARD_VARIANTS: readonly WorkBuddyCardVariant[] = [
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
  {
    id: 'anyconnect-zcode',
    statusPath: ZCODE_STATUS_PATH,
    probePath: ZCODE_PROBE_PATH,
    titleKey: 'titleZcode',
    introKey: 'introZcode',
    signedOutHintKey: 'signedOutHintZcode',
  },
  {
    id: 'anyconnect-zcode-offpeak',
    statusPath: ZCODE_OFFPEAK_STATUS_PATH,
    probePath: ZCODE_OFFPEAK_PROBE_PATH,
    titleKey: 'titleZcodeOffpeak',
    introKey: 'introZcodeOffpeak',
    signedOutHintKey: 'signedOutHintZcodeOffpeak',
  },
]

/**
 * Card status = the host document plus client-side `loading`/`error` phases.
 * The host never emits either: `loading` covers the first round trip (mount
 * fetches all variants in parallel), and `error` means the status document
 * itself could not be read — rendered as a retryable row, never as a crash.
 */
type CardStatus =
  | WorkBuddyWebStatus
  | { status: 'loading' }
  | { status: 'error'; message: string }

/** Props delivered by the Plugins page's bundle-configuration slot. */
export type WorkBuddyConfigPageProps =
  PropsRuntime<'plugins.bundle.config'>
  & Partial<WorkBuddyConfigPageInjected>

const POLL_INTERVAL_MS = 60_000
/** POST refresh 后等目录异步落地的宽限：refresh 立即返回，目录在后台拉取。 */
const REFRESH_SETTLE_MS = 2_000
/** 两段式确认的复位窗口。 */
const CONFIRM_RESET_MS = 4_000

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
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }
const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px', display: 'flex', flexDirection: 'column', gap: 16 }

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 30, padding: '4px 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 15, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const chipRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }
const chipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}
const chipNeutralStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05))',
  color: 'var(--dsw-alias-label-tertiary)',
}
const modelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }
const modelNameStyle: CSSProperties = { flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const detectButtonStyle: CSSProperties = {
  ...buttonStyle,
  minHeight: 22,
  padding: '1px 8px',
  fontSize: 11,
  borderRadius: 11,
}
const linkButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: 0,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  minHeight: 22,
  padding: '1px 4px',
  fontSize: 11,
}
const detailsToggleStyle: CSSProperties = {
  ...buttonStyle,
  border: 0,
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  padding: '2px 0',
  fontSize: 12,
}
const detailsBoxStyle: CSSProperties = {
  border: '1px dashed var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '8px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}
const hintStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const checkLabelStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', userSelect: 'none' }
const checkStyle: CSSProperties = { accentColor: 'var(--dsw-alias-label-primary)', width: 13, height: 13, cursor: 'pointer' }
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
const signedOutRowStyle: CSSProperties = {
  ...cardStyle,
}
const signedOutRowHeadStyle: CSSProperties = {
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
const signedOutBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '10px 14px 12px' }

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

/** Compact token count: 1000000 → "1M", 256000 → "256K", else grouped digits.
 * 目录窗口是十进制整数（1_000_000），按十进制取整缩写而不是二进制 MiB。 */
function formatTokens(value: number): string {
  if (Number.isFinite(value) && value >= 1_000_000 && value % 1_000_000 === 0) {
    return `${value / 1_000_000}M`
  }
  if (Number.isFinite(value) && value >= 1000 && value % 1000 === 0) {
    return `${value / 1000}K`
  }
  return new Intl.NumberFormat(undefined).format(value)
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
}

/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
function modelBadgeLabel(badge: string, t: WorkBuddyConfigPageInjected['t']): string {
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

/** One billing package as a labeled progress bar. */
function CreditBar({ label, remain, size, t }: {
  label: string
  remain: number
  size: number
  t: WorkBuddyConfigPageInjected['t']
}): React.ReactNode {
  const detail = size > 0 ? t('exactRemaining', { remain: formatNumber(remain), size: formatNumber(size) }) : t('creditPackageUnknownSize', { remain: formatNumber(remain) })
  const percent = size > 0 ? (remain / size) * 100 : 100
  // remain 理论上可超过 size（上游记账口径不保证一致）：进度条宽度与
  // aria-valuenow 夹到 [0,100]，避免出现 ">100%" 的剩余读数。
  const clamped = Math.max(0, Math.min(100, percent))
  const display = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(clamped)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
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
      <p style={hintStyle}>{detail}</p>
    </div>
  )
}

/**
 * One-line catalog provenance: live (just fetched) → saved (this account's
 * last good list, restored after restart/failure) → fallback (compiled in).
 * A stale list must not look like a live one.
 */
function catalogLine(catalog: WorkBuddyWebCatalog, t: WorkBuddyConfigPageInjected['t']): string {
  const base = catalog.source === 'live'
    ? t('catalogLive')
    : catalog.source === 'saved'
      ? t('catalogSaved', { time: catalog.fetchedAt === undefined ? '?' : formatTime(catalog.fetchedAt) })
      : t('catalogFallback')
  return catalog.error === undefined ? base : `${base} — ${t('catalogError', { message: catalog.error })}`
}

/** One row of the unified model list. */
function ModelRow({ row, efforts, notValidating, detecting, pendingDetect, busy, onDetect, t }: {
  row: WorkBuddyWebModelRow
  /** The effort levels to display: declared, detected, or none. */
  efforts: readonly string[] | undefined
  /** Detection concluded the upstream does not validate the parameter. */
  notValidating: boolean
  detecting: boolean
  pendingDetect: boolean
  busy: boolean
  /** Absent for models that cannot be probed (declared, or not a candidate). */
  onDetect: (() => void) | undefined
  t: WorkBuddyConfigPageInjected['t']
}): React.ReactNode {
  return (
    <div style={modelRowStyle}>
      <span style={modelNameStyle} title={row.name}>{row.name}</span>
      <span style={chipRowStyle}>
        {row.free === true ? <span style={chipStyle}>{t('freeModel')}</span>
          : row.credits !== undefined ? <span style={modelRateStyle}>{row.credits}</span>
          : row.rateUnknown === true ? <span style={modelRateStyle}>{t('rateUnknown')}</span>
          : null}
        {row.badges?.map(badge => (
          <span key={badge} style={chipStyle}>{modelBadgeLabel(badge, t)}</span>
        ))}
        <span style={chipNeutralStyle}>{formatTokens(row.contextWindow)}</span>
        {efforts !== undefined && efforts.length > 0
          ? <span style={chipNeutralStyle}>{efforts.join('/')}</span>
          : notValidating
            ? <span style={chipNeutralStyle}>{t('probeNotValidating')}</span>
            : detecting
              ? <span style={chipNeutralStyle}>{t('detectingShort')}</span>
              : onDetect !== undefined
                ? <button type="button" style={detectButtonStyle} disabled={busy} onClick={onDetect}>
                    {pendingDetect ? t('detectOneConfirm') : t('detectOne')}
                  </button>
                : null}
      </span>
    </div>
  )
}

/** The night-free window line (zcode-offpeak only). */
function OffPeakWindowRow({ window, t }: {
  window: WorkBuddyWebOffPeakWindow
  t: WorkBuddyConfigPageInjected['t']
}): React.ReactNode {
  const text = window.error !== undefined
    ? t('offpeakWindowError', { message: window.error })
    : window.canTakeNumber
      ? t('offpeakWindowOpen')
      : window.nextTakeAtSec !== undefined
        ? t('offpeakWindowNext', { time: formatTime(window.nextTakeAtSec * 1000) })
        : t('offpeakWindowClosed')
  return <p style={bodyStyle}>{t('offpeakWindow')}：{text}</p>
}

/**
 * The bundle's configuration entry on its Plugins page. The page draws the
 * title, icon, and crumb itself and asks each entry for two views through its
 * owner props; this slot's contract is `page`-only, so the defensive non-`page`
 * branch stays a static one-liner instead of polling account state.
 */
export function WorkBuddyConfigPage({ t, view }: WorkBuddyConfigPageProps): React.ReactNode {
  if (t === undefined) throw new Error('WorkBuddy config page requires its translation function')
  if (view !== 'page') return t('intro')
  return <VariantsPage t={t} />
}

/**
 * The variants page: one status fetch per variant at mount decides the layout.
 * Signed-in variants render as full cards (the first one opens by default);
 * the rest collapse into quiet one-line rows, so a user who only uses one
 * product never scrolls past three "not signed in" cards. A slow background
 * poll re-checks only the collapsed rows, so a sign-in that happens after the
 * page is open promotes itself without a reload.
 */
function VariantsPage({ t }: { t: WorkBuddyConfigPageInjected['t'] }): React.ReactNode {
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({})
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())
  // 自动展开只发生一次（首个确认已登录的变体），之后完全由用户控制。
  const autoExpandedRef = useRef(false)
  const mountedRef = useRef(true)
  // interval 闭包里要读到最新的表与展开集：state 之外的同步镜像。
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const openIdsRef = useRef(openIds)
  openIdsRef.current = openIds

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchOne = useCallback(async (variant: WorkBuddyCardVariant, signal?: AbortSignal): Promise<WorkBuddyWebStatus> => {
    const response = await fetch(variant.statusPath, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...signal === undefined ? {} : { signal },
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const detail = typeof (value as { error?: unknown } | null)?.error === 'string'
        ? `: ${(value as { error: string }).error}`
        : ''
      throw new Error(`HTTP ${response.status}${detail}`)
    }
    // 非 JSON 的 200（中间代理、204）不能进状态表：形状不对按失败处理，
    // 渲染层要读 status.status，undefined 会直接把渲染树打崩。
    if (value === null || typeof value !== 'object' || typeof (value as { status?: unknown }).status !== 'string') {
      throw new Error('unexpected status payload')
    }
    return value as WorkBuddyWebStatus
  }, [])

  const applyOne = useCallback((variantId: string, next: CardStatus): void => {
    if (mountedRef.current) setStatuses(current => ({ ...current, [variantId]: next }))
  }, [])

  // 挂载：并行拉全部变体；之后 60s 轮询只刷「未登录」与「已展开」的变体，
  // 收起的已登录卡不打扰（展开时由卡片立即拉取）。
  useEffect(() => {
    for (const variant of CARD_VARIANTS) {
      fetchOne(variant).then(
        status => applyOne(variant.id, status),
        error => applyOne(variant.id, { status: 'error', message: error instanceof Error ? error.message : String(error) }),
      )
    }
    const timer = window.setInterval(() => {
      for (const variant of CARD_VARIANTS) {
        const current = statusesRef.current[variant.id]
        const needsPoll = current === undefined
          || current.status !== 'signed-in'
          || openIdsRef.current.has(variant.id)
        if (!needsPoll) continue
        void fetchOne(variant).then(
          status => applyOne(variant.id, status),
          () => { /* 轮询失败不打扰：下一拍再试，已有数据保留 */ },
        )
      }
    }, POLL_INTERVAL_MS)
    return () => { window.clearInterval(timer) }
  }, [fetchOne, applyOne])

  // 首个已登录的变体自动展开一次。等全部变体的首拉落定再选——status 路由
  // 快慢不一（workbuddy 要等上游积分应答，zcode 只读本地文件），按"谁先回
  // 来"选会展开错误的卡片；落定后按声明顺序取第一个已登录的。
  useEffect(() => {
    if (autoExpandedRef.current) return
    const settled = CARD_VARIANTS.every(variant => {
      const current = statuses[variant.id]
      return current !== undefined && current.status !== 'loading'
    })
    if (!settled) return
    const first = CARD_VARIANTS.find(variant => statuses[variant.id]?.status === 'signed-in')
    if (first !== undefined) {
      autoExpandedRef.current = true
      setOpenIds(current => {
        const next = new Set(current)
        next.add(first.id)
        return next
      })
    }
  }, [statuses])

  const toggleOpen = useCallback((id: string): void => {
    setOpenIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const anySignedIn = CARD_VARIANTS.some(variant => statuses[variant.id]?.status === 'signed-in')
  const loaded = CARD_VARIANTS.some(variant => statuses[variant.id] !== undefined)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {loaded && !anySignedIn ? <p style={hintStyle}>{t('allSignedOutHint')}</p> : null}
      {CARD_VARIANTS.map(variant => {
        const status = statuses[variant.id] ?? { status: 'loading' as const }
        if (status.status === 'signed-in') {
          return (
            <VariantCard
              key={variant.id}
              t={t}
              variant={variant}
              status={status}
              open={openIds.has(variant.id)}
              onToggle={() => toggleOpen(variant.id)}
              fetchStatus={signal => fetchOne(variant, signal)}
              applyStatus={next => applyOne(variant.id, next)}
            />
          )
        }
        return <SignedOutRow key={variant.id} t={t} variant={variant} status={status} />
      })}
    </div>
  )
}

/** Control action posted to the variant's probe route (key travels in a header). */
type ProbeAction = { action: 'probe'; model: string } | { action: 'clear' } | { action: 'refresh' } | { action: 'set-consent'; enabled: boolean }

/** One signed-in variant's card: account, credit, unified model list, detection. */
function VariantCard({ t, variant, status, open, onToggle, fetchStatus, applyStatus }: {
  t: WorkBuddyConfigPageInjected['t']
  variant: WorkBuddyCardVariant
  status: Extract<CardStatus, { status: 'signed-in' }>
  open: boolean
  onToggle: () => void
  /** Re-read this variant's status document (caller owns state updates). */
  fetchStatus: (signal?: AbortSignal) => Promise<WorkBuddyWebStatus>
  applyStatus: (next: CardStatus) => void
}): React.ReactNode {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // 两段式确认（单个检测的行内按钮 + 批量按钮共用 4s 窗口）。
  const [pendingDetect, setPendingDetect] = useState<string | undefined>(undefined)
  const [confirmingAll, setConfirmingAll] = useState(false)
  // 批量进度与单模型检测中的 id 集合：本地 UI 状态——宿主的 probe.running
  // 只反映"当前正在跑的一个"，整批进度只能客户端自己数。
  const [batch, setBatch] = useState<{ total: number; done: number } | undefined>(undefined)
  const [detectingIds, setDetectingIds] = useState<ReadonlySet<string>>(new Set())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const probe: WorkBuddyWebProbeSection | undefined = status.probe
  const probeKey = status.probeKey

  /** Re-read the status document; failures degrade to an inline notice — with
   * data already on screen a transient failure must not blank the card. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchStatus()
      if (mounted.current) applyStatus(next)
    } catch (error: unknown) {
      if (mounted.current) {
        setNotice(error instanceof Error ? error.message : t('requestFailed'))
      }
    }
  }, [applyStatus, fetchStatus, t])

  const control = useCallback(async (action: ProbeAction): Promise<void> => {
    if (probeKey === undefined) throw new Error(t('requestFailed'))
    const response = await fetch(variant.probePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-probe-key': probeKey },
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
  }, [probeKey, t, variant.probePath])

  /** The merged refresh button: ask the host to re-pull the catalog first
   * (returns immediately), give it a short grace period to land, then read
   * the status document. */
  const refreshWithCatalog = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      await control({ action: 'refresh' })
      await new Promise(resolve => setTimeout(resolve, REFRESH_SETTLE_MS))
    } catch (error: unknown) {
      // refresh POST 失败也照常读一次 status：读本身可能仍是成功的。
      if (mounted.current) setNotice(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      await refresh()
      if (mounted.current) setBusy(false)
    }
  }, [control, refresh, t])

  // Stale 目录自动刷新一次：saved/fallback 或上次失败时，后台重拉目录，
  // 用户不用按刷新。once per mount；失败只进 notice，不打扰不循环。
  const autoRefreshTried = useRef(false)
  useEffect(() => {
    if (autoRefreshTried.current) return
    if (probeKey === undefined) return
    const catalog = status.catalog
    if (catalog === undefined) return
    if (catalog.source === 'live' && catalog.error === undefined) return
    autoRefreshTried.current = true
    void refreshWithCatalog()
  }, [probeKey, status.catalog, refreshWithCatalog])

  const runControl = useCallback(async (action: ProbeAction): Promise<void> => {
    setBusy(true)
    try {
      await control(action)
    } catch (error: unknown) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      await refresh()
      if (mounted.current) setBusy(false)
    }
  }, [control, refresh, t])

  /** One manual probe (two-step confirm is handled by the caller). */
  const runOneDetect = useCallback(async (modelId: string): Promise<void> => {
    setBusy(true)
    setDetectingIds(current => new Set(current).add(modelId))
    try {
      await control({ action: 'probe', model: modelId })
    } catch (error: unknown) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      await refresh()
      if (mounted.current) {
        setBusy(false)
        setDetectingIds(current => {
          const next = new Set(current)
          next.delete(modelId)
          return next
        })
      }
    }
  }, [control, refresh, t])

  /**
   * Batch-detect every candidate. Requests are issued in parallel while the
   * host's serial queue runs them one by one — each request resolves as its
   * model finishes, which is exactly the progress the button counts.
   */
  const runBatchDetect = useCallback(async (targets: readonly string[]): Promise<void> => {
    if (targets.length === 0) return
    setBusy(true)
    setBatch({ total: targets.length, done: 0 })
    setNotice(undefined)
    await Promise.allSettled(targets.map(async modelId => {
      try {
        await control({ action: 'probe', model: modelId })
      } catch { /* 单个失败由最终刷新后的 results 呈现 */ }
      if (mounted.current) setBatch(current => current === undefined ? current : { ...current, done: current.done + 1 })
    }))
    await refresh()
    if (mounted.current) {
      setBatch(undefined)
      setBusy(false)
    }
  }, [control, refresh])

  const detecting = batch !== undefined
  const probeable = probe !== undefined

  // 4s 确认窗口复位。
  useEffect(() => {
    if (!confirmingAll && pendingDetect === undefined) return
    const timer = window.setTimeout(() => {
      setConfirmingAll(false)
      setPendingDetect(undefined)
    }, CONFIRM_RESET_MS)
    return () => { window.clearTimeout(timer) }
  }, [confirmingAll, pendingDetect])

  // sweep 结束（或目录刷新移除了候选）后，残留确认态作废。
  const candidates = probe?.candidates ?? []
  useEffect(() => {
    if (pendingDetect !== undefined && !candidates.includes(pendingDetect)) {
      setPendingDetect(undefined)
    }
  }, [pendingDetect, candidates])

  const detectable = candidates.filter(id => {
    const result = probe?.results.find(entry => entry.id === id)
    return result === undefined || result.validation === 'unknown'
  })

  const title = t(variant.titleKey)
  const label = status.nickname === undefined
    ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '')
    : t('signedInAs', { nickname: status.nickname })

  // 卡头摘要：已登录身份 + 积分合计 + 模型数，常见查询零点击。
  // 静态产品介绍退到 title tooltip，不丢失。
  const headerSummary = [
    label,
    status.credits !== undefined ? t('creditsTotal', { total: formatNumber(status.credits.total) }) : undefined,
    status.models !== undefined ? t('modelsCount', { n: status.models.length }) : undefined,
  ].filter(part => part !== undefined).join(' · ')

  /** Efforts shown on one model row: a declared set wins, then a validating
   * observation (mirrors the adapter's own precedence). */
  const effortsOf = (row: WorkBuddyWebModelRow): readonly string[] | undefined => {
    if (row.efforts !== undefined && row.efforts.length > 0) return row.efforts
    const result = probe?.results.find(entry => entry.id === row.id)
    return result !== undefined && result.validation === 'validating' ? result.efforts : undefined
  }
  const notValidatingOf = (row: WorkBuddyWebModelRow): boolean => {
    if (row.efforts !== undefined && row.efforts.length > 0) return false
    const result = probe?.results.find(entry => entry.id === row.id)
    return result?.validation === 'non-validating'
  }

  return (
    <div style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={onToggle}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{title}</span>
          <span style={descriptionStyle} title={t(variant.introKey)}>{headerSummary}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open ? (
        <div style={cardBodyStyle}>
          <div style={rowStyle}>
            <div style={statusStyle} role="status">
              <span aria-hidden="true" style={dotStyle('signed-in')} />
              <span>{label}</span>
            </div>
            <button
              type="button"
              style={buttonStyle}
              disabled={busy}
              title={t('catalogLive')}
              onClick={() => { void refreshWithCatalog() }}
            >
              {busy ? t('refreshing') : t('refresh')}
            </button>
          </div>
          {notice !== undefined ? <p style={{ ...errorStyle, fontSize: 12 }} role="alert">{t('refreshFailed', { message: notice })}</p> : null}

          {status.credits !== undefined ? (
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
          ) : null}
          {status.creditsError !== undefined
            ? <p style={{ ...errorStyle, fontSize: 12 }}>{t('creditsError', { message: status.creditsError })}</p>
            : null}

          {status.offPeakWindow !== undefined ? <OffPeakWindowRow window={status.offPeakWindow} t={t} /> : null}

          {status.models !== undefined && status.models.length > 0 ? (
            <div style={quotaListStyle}>
              <h3 style={quotaTitleStyle}>{t('modelsCount', { n: status.models.length })}</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {status.models.map(row => {
                  const isCandidate = probeable && candidates.includes(row.id)
                  const hasEfforts = effortsOf(row) !== undefined || notValidatingOf(row)
                  return (
                    <ModelRow
                      key={row.id}
                      row={row}
                      t={t}
                      efforts={effortsOf(row)}
                      notValidating={notValidatingOf(row)}
                      detecting={detectingIds.has(row.id)}
                      busy={busy || detecting}
                      // 已授权（自动检测开）时不走两段式：pending 确认只留给
                      // 未授权的手动探测，授权态点一次直接跑。
                      pendingDetect={pendingDetect === row.id && probe?.consent !== true}
                      onDetect={!isCandidate || hasEfforts ? undefined : () => {
                        if (probe?.consent === true) {
                          setPendingDetect(undefined)
                          void runOneDetect(row.id)
                          return
                        }
                        if (pendingDetect === row.id) {
                          setPendingDetect(undefined)
                          void runOneDetect(row.id)
                        } else {
                          setPendingDetect(row.id)
                        }
                      }}
                    />
                  )
                })}
              </div>
            </div>
          ) : null}

          {probeable ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={rowStyle}>
                <label style={checkLabelStyle} title={t('autoDetectHint')}>
                  <input
                    type="checkbox"
                    style={checkStyle}
                    checked={probe?.consent === true}
                    disabled={busy || detecting}
                    onChange={e => {
                      setConfirmingAll(false)
                      setPendingDetect(undefined)
                      void runControl({ action: 'set-consent', enabled: e.target.checked })
                    }}
                  />
                  {t('autoDetect')}
                </label>
                {batch !== undefined
                  ? <span style={modelRateStyle}>{t('detecting', { done: batch.done, total: batch.total })}</span>
                  : detectable.length > 0 ? (
                    confirmingAll ? (
                      <button
                        type="button"
                        style={{ ...primaryButtonStyle, minHeight: 26, padding: '2px 10px', fontSize: 12, borderRadius: 13 }}
                        disabled={busy}
                        onClick={() => { setConfirmingAll(false); void runBatchDetect(detectable) }}
                      >
                        {t('detectAllConfirm', { n: detectable.length })}
                      </button>
                    ) : (
                      <button
                        type="button"
                        style={{ ...buttonStyle, minHeight: 26, padding: '2px 10px', fontSize: 12, borderRadius: 13 }}
                        disabled={busy}
                        title={t('autoDetectHint')}
                        // 已授权时一批直接跑，未授权才进两段式确认。
                        onClick={() => {
                          if (probe?.consent === true) void runBatchDetect(detectable)
                          else setConfirmingAll(true)
                        }}
                      >
                        {t('detectAll', { n: detectable.length })}
                      </button>
                    )
                  ) : null}
              </div>
              {probe?.consent === true ? <p style={hintStyle}>{t('autoDetectHint')}</p> : null}
            </div>
          ) : null}

          <div>
            <button type="button" style={detailsToggleStyle} aria-expanded={detailsOpen} onClick={() => { setDetailsOpen(!detailsOpen) }}>
              {detailsOpen ? '▾' : '▸'} {t('details')}
            </button>
            {detailsOpen ? (
              <div style={detailsBoxStyle}>
                {status.expiresAt !== undefined
                  ? <p style={hintStyle}>{t('accessTokenExpires', { time: formatTime(status.expiresAt) })}</p>
                  : null}
                {status.catalog !== undefined
                  ? <p style={hintStyle}>{catalogLine(status.catalog, t)}</p>
                  : null}
                {probeable && (probe?.results.length ?? 0) > 0 ? (
                  <button type="button" style={linkButtonStyle} disabled={busy || detecting} onClick={() => { void runControl({ action: 'clear' }) }}>
                    {t('clearResults')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** One collapsed row per signed-out (or unreadable) variant. */
function SignedOutRow({ t, variant, status }: {
  t: WorkBuddyConfigPageInjected['t']
  variant: WorkBuddyCardVariant
  status: CardStatus
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const title = t(variant.titleKey)
  const detail = status.status === 'error'
    ? status.message
    : status.status === 'signed-out' && status.reason !== undefined
      ? status.reason
      : t(variant.signedOutHintKey)
  return (
    <div style={signedOutRowStyle}>
      <button type="button" style={signedOutRowHeadStyle} aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span aria-hidden="true" style={dotStyle(status.status)} />
        <span style={{ ...nameStyle, flex: '0 0 auto', fontWeight: 500 }}>{title}</span>
        <span style={{ ...descriptionStyle, flex: 1, minWidth: 0, whiteSpace: open ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: open ? 'clip' : 'ellipsis' }}>
          {status.status === 'loading' ? t('loading') : t('signedOut')}
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, fontSize: 14, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open ? <div style={signedOutBodyStyle}><p style={hintStyle}>{detail}</p></div> : null}
    </div>
  )
}
