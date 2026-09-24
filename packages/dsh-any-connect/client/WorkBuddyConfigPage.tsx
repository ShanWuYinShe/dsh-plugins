/** WorkBuddy configuration page contributed to the DSH Plugins page. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  WORKBUDDY_AI_PROBE_PATH,
  WORKBUDDY_AI_STATUS_PATH,
  WORKBUDDY_PROBE_PATH,
  WORKBUDDY_STATUS_PATH,
  ZCODE_PROBE_PATH,
  ZCODE_STATUS_PATH,
} from '../src/status-paths.js'
import type { WorkBuddyWebModelRow, WorkBuddyWebProbeSection, WorkBuddyWebStatus } from '../src/status-paths.js'
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
    titleKey: 'titleZCode',
    introKey: 'introZCode',
    signedOutHintKey: 'signedOutHintZCode',
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
  padding: '12px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 2 }
const nameRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const summaryStyle: CSSProperties = { paddingLeft: 16, fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }
const chevronStyle: CSSProperties = { flex: '0 0 auto', fontSize: 18, lineHeight: 1, transition: 'transform 120ms ease' }
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }
const dividerStyle: CSSProperties = { border: 0, borderTop: '1px solid var(--dsw-alias-border-l2)', margin: 0 }
/** 卡体摘要行：左标签右数值，一行讲完当前积分（刷新按钮同行）。 */
const summaryRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const summaryLabelStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' }
const summaryValueStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' }
const summaryHeadStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
/** 模型清单的折叠开关：与区块标题同样的低调小号灰字。 */
const summaryToggleStyle: CSSProperties = {
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
const summaryNoteStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', fontVariantNumeric: 'tabular-nums' }

const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const descriptionStyle: CSSProperties = { fontSize: 12, lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 26, padding: '3px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12, lineHeight: '18px', cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const hintStyle: CSSProperties = { margin: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '16px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}
const modelBadgesStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }
const modelTableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }
const modelThStyle: CSSProperties = {
  padding: '4px 6px 6px',
  fontSize: 11,
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '0.02em',
  color: 'var(--dsw-alias-label-tertiary)',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}
const modelRowBaseStyle: CSSProperties = { borderRadius: 6 }
const modelRowEvenStyle: CSSProperties = { ...modelRowBaseStyle, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.025))' }
const modelTdStyle: CSSProperties = { padding: '5px 6px' }
const modelNameStyle: CSSProperties = { ...modelTdStyle, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }
const metaCellStyle: CSSProperties = { ...modelTdStyle, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

const planCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03))',
  border: '1px solid var(--dsw-alias-border-l2)',
}
const planTitleRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }
const planNameStyle: CSSProperties = { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const planBadgeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }
const privilegeChipStyle: CSSProperties = {
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
const planMetaStyle: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' }

function formatExpiry(iso?: string): string {
  if (iso === undefined || iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d)
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

/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
function modelBadgeLabel(badge: string, t: WorkBuddyConfigPageInjected['t']): string {
  if (badge === '限时免费') return t('badgeLimitedFree')
  if (badge === '夜间折扣') return t('badgeNightDiscount')
  return badge
}

/**
 * One row of the model table: name, badges, rate, context window, efforts.
 * Column widths are shared across all rows because the parent is a semantic
 * `<table>`, so tabular figures line up perfectly. Even-indexed rows get a
 * subtle background for visual grouping.
 */
function ModelRow({ row, efforts, t, even }: {
  row: WorkBuddyWebModelRow
  /** The effort levels the model accepts: declared, or automatically detected. */
  efforts: readonly string[] | undefined
  t: WorkBuddyConfigPageInjected['t']
  /** Whether this is an even-indexed row (for zebra striping). */
  even: boolean
}): React.ReactNode {
  return (
    <tr style={even ? modelRowEvenStyle : modelRowBaseStyle}>
      <td style={modelNameStyle} title={row.name}>{row.name}</td>
      <td style={modelTdStyle}>
        <span style={modelBadgesStyle}>
          {row.free === true ? <span style={chipStyle}>{t('freeModel')}</span> : null}
          {row.badges?.map(badge => (
            <span key={badge} style={chipStyle}>{modelBadgeLabel(badge, t)}</span>
          ))}
        </span>
      </td>
      <td style={metaCellStyle}>{row.free === true ? null : row.rateUnknown === true ? t('rateUnknown') : row.credits}</td>
      <td style={metaCellStyle}>{formatTokens(row.contextWindow)}</td>
      <td style={{ ...metaCellStyle, color: 'var(--dsw-alias-label-secondary)' }}>
        {efforts !== undefined && efforts.length > 0 ? efforts.join('/') : null}
      </td>
    </tr>
  )
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
  // 快慢不一（各 status 路由响应快慢不一），按"谁先回
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
type ProbeAction = { action: 'refresh' }

/**
 * One signed-in variant's card: account, credit, unified model list. Detection
 * of reasoning-effort levels is automatic host-side (a background sweep after
 * every catalog refresh), so the card only shows its outcome — no detect
 * buttons, no opt-in switch.
 */
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
  // 模型清单默认收起：它是最长的一段，而卡片的常看信息只有积分本身。
  const [modelsOpen, setModelsOpen] = useState(false)
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

  const title = t(variant.titleKey)
  const label = status.nickname === undefined
    ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '')
    : t('signedInAs', { nickname: status.nickname })

  const isZCode = variant.id === 'anyconnect-zcode'
  const zcodePlan = isZCode && status.credits?.accounts !== undefined
    ? (status.credits.accounts.find(a => a.remain > 0) ?? status.credits.accounts[0])
    : undefined
  const zcodePlanName = zcodePlan ? zcodePlan.packageName.replace(/\s*\((?:有效|VALID|EXPIRED|已过期)\)$/i, '') : undefined
  const isPlanActive = zcodePlan !== undefined && zcodePlan.remain > 0

  // 卡头摘要：已登录身份 + 当前积分/套餐状态，收起态下也要一眼看到。
  const headerSummary = isZCode
    ? [
        label,
        zcodePlanName !== undefined
          ? `${zcodePlanName} · ${t(isPlanActive ? 'codingPlanActive' : 'codingPlanExpired')}`
          : (status.credits !== undefined ? t('codingPlanActive') : undefined),
      ].filter(part => part !== undefined).join(' · ')
    : [
        label,
        status.credits !== undefined ? t('creditsTotal', { total: formatNumber(status.credits.total) }) : undefined,
      ].filter(part => part !== undefined).join(' · ')

  /** Efforts shown on one model row: a declared set wins, then a validating
   * observation (mirrors the adapter's own precedence). Models whose probe
   * concluded "upstream ignores the parameter" simply show no levels. */
  const effortsOf = (row: WorkBuddyWebModelRow): readonly string[] | undefined => {
    if (row.efforts !== undefined && row.efforts.length > 0) return row.efforts
    const result = probe?.results.find(entry => entry.id === row.id)
    return result !== undefined && result.validation === 'validating' ? result.efforts : undefined
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
          <span style={nameRowStyle}>
            <span aria-hidden="true" style={dotStyle('signed-in')} />
            <span style={nameStyle}>{title}</span>
          </span>
          <span style={summaryStyle} title={t(variant.introKey)}>{headerSummary}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open ? (
        <div style={cardBodyStyle}>
          {isZCode ? (
            <>
              <hr style={dividerStyle} />
              <div style={planCardStyle}>
                <div style={planTitleRowStyle}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={planNameStyle}>{zcodePlanName ?? t('codingPlanLabel')}</span>
                    <span style={isPlanActive ? chipStyle : { ...chipStyle, background: 'rgba(0,0,0,0.06)', color: 'var(--dsw-alias-label-tertiary)' }}>
                      {t(isPlanActive ? 'codingPlanActive' : 'codingPlanExpired')}
                    </span>
                  </div>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => { void refreshWithCatalog() }}
                  >
                    {busy ? t('refreshing') : t('refresh')}
                  </button>
                </div>
                <div style={planBadgeRowStyle}>
                  <span style={privilegeChipStyle}>⚡ {t('codingPlanExtraQuota')}</span>
                  <span style={privilegeChipStyle}>🌙 {t('codingPlanNightFree')}</span>
                </div>
                {zcodePlan?.expiredAt ? (
                  <span style={planMetaStyle}>
                    {t('codingPlanExpiresAt', { date: formatExpiry(zcodePlan.expiredAt) })}
                  </span>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <hr style={dividerStyle} />
              <div style={summaryRowStyle}>
                <span style={summaryLabelStyle}>{t('creditsLabel')}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={summaryValueStyle} title={status.domain}>
                    {status.credits !== undefined ? formatNumber(status.credits.total) : '—'}
                  </span>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => { void refreshWithCatalog() }}
                  >
                    {busy ? t('refreshing') : t('refresh')}
                  </button>
                </span>
              </div>
            </>
          )}
          {notice !== undefined ? <p style={{ ...errorStyle, fontSize: 12 }} role="alert">{t('refreshFailed', { message: notice })}</p> : null}
          {status.creditsError !== undefined
            ? <p style={{ ...errorStyle, fontSize: 12 }}>{t('creditsError', { message: status.creditsError })}</p>
            : null}

          {status.models !== undefined && status.models.length > 0 ? (
            <>
              <hr style={dividerStyle} />
              <div style={summaryHeadStyle}>
                <button
                  type="button"
                  style={summaryToggleStyle}
                  aria-expanded={modelsOpen}
                  onClick={() => { setModelsOpen(!modelsOpen) }}
                >
                  <span aria-hidden="true" style={{ ...chevronStyle, fontSize: 14, transform: modelsOpen ? 'rotate(180deg)' : 'none' }}>⌄</span>
                  <span>{t('modelsCount', { n: status.models.length })}</span>
                </button>
                {probe?.running === true ? <span style={summaryNoteStyle}>{t('detectingShort')}</span> : null}
              </div>
              {modelsOpen ? (
                <table style={modelTableStyle}>
                  <thead>
                    <tr>
                      <th style={{ ...modelThStyle, textAlign: 'left' }}>{t('colName')}</th>
                      <th style={modelThStyle} />
                      <th style={{ ...modelThStyle, textAlign: 'right' }}>{t('colRate')}</th>
                      <th style={{ ...modelThStyle, textAlign: 'right' }}>{t('colContext')}</th>
                      <th style={{ ...modelThStyle, textAlign: 'right' }}>{t('colEfforts')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.models.map((row, i) => (
                      <ModelRow
                        key={row.id}
                        row={row}
                        t={t}
                        efforts={effortsOf(row)}
                        even={i % 2 === 1}
                      />
                    ))}
                  </tbody>
                </table>
              ) : null}
            </>
          ) : null}
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
