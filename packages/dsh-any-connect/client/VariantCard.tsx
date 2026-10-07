/**
 * VariantCard.tsx — 单个变体卡片：账号/额度/模型/探针与领取入口。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事，
 * 页面入口与 re-export 保留在 WorkBuddyConfigPage.tsx。
 *
 * @module dsh-any-connect/client/VariantCard
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type WorkBuddyWebCatalog,
  type WorkBuddyWebModelRow,
  type WorkBuddyWebProbeSection,
  type WorkBuddyWebStartPlanClaim,
  type WorkBuddyWebStatus,
} from '../src/status-paths.js'
import { REFRESH_POLL_MS, REFRESH_TIMEOUT_MS, isCatalogLive, catalogSourceKey } from './config-types.js'
import { type WorkBuddyConfigPageInjected, type WorkBuddyCardVariant, type CardStatus } from './config-types.js'
import {
  cardStyle,
  headerStyle,
  headTextStyle,
  nameRowStyle,
  nameStyle,
  summaryStyle,
  chevronStyle,
  cardBodyStyle,
  dividerStyle,
  summaryRowStyle,
  summaryLabelStyle,
  summaryValueStyle,
  summaryHeadStyle,
  summaryToggleStyle,
  summaryNoteStyle,
  buttonStyle,
  errorStyle,
  chipStyle,
  modelTableStyle,
  modelThStyle,
  planCardStyle,
  planTitleRowStyle,
  planNameStyle,
  planBadgeRowStyle,
  privilegeChipStyle,
  planMetaStyle,
  claimBoxStyle,
  claimUnknownBoxStyle,
  claimTitleStyle,
  claimIdRowStyle,
  claimCodeStyle,
  planChipOffStyle,
  dotStyle,
} from './config-styles.js'
import { formatExpiry, formatNumber } from './config-format.js'
import { ModelRow } from './ModelRow.js'

/** Control action posted to the variant's probe route (key travels in a header). */
type ProbeAction = { action: 'refresh' }

/**
 * One signed-in variant's card: account, credit, unified model list. Detection
 * of reasoning-effort levels is automatic host-side (a background sweep after
 * every catalog refresh), so the card only shows its outcome — no detect
 * buttons, no opt-in switch.
 */
export function VariantCard({ t, variant, status, open, onToggle, fetchStatus, applyStatus }: {
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
  // 「已复制」是短暂反馈：复制成功给一次确认，2s 后自行复原，不留陈旧状态。
  const [copiedPlanId, setCopiedPlanId] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const probe: WorkBuddyWebProbeSection | undefined = status.probe
  const probeKey = status.probeKey
  /** 今日 Start Plan 待领取探测结果；只有 Start Plan 变体的 status 会带。 */
  const startPlanClaim: WorkBuddyWebStartPlanClaim | undefined = status.startPlanClaim

  /**
   * 把 plan_id 复制到剪贴板（用户要拿着它去客户端核对领取的活动）。
   *
   * 剪贴板在非安全上下文/无权限时会 reject，所以失败只当作"没复制"静默处理：
   * 这个按钮是便利功能，不该因为浏览器权限弹错误打断卡片。
   */
  const copyPlanId = useCallback(async (planId: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(planId)
      if (!mounted.current) return
      setCopiedPlanId(true)
      window.setTimeout(() => { if (mounted.current) setCopiedPlanId(false) }, 2000)
    } catch {
      // 复制失败不改状态：plan_id 本身已经显示在卡片上，用户仍可手动选中复制。
    }
  }, [])

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

  /** 等目录落地：每次重读 status，live 即停、超时即停。首读立即发生，
   * 替代固定盲等（目录快时白等、慢时读到旧目录又触发二次刷新）。 */
  const waitCatalogLive = useCallback(async (): Promise<void> => {
    const startedAt = Date.now()
    for (;;) {
      let next: WorkBuddyWebStatus
      try {
        next = await fetchStatus()
      } catch {
        return
      }
      if (!mounted.current) return
      applyStatus(next)
      // signed-out 文档无 catalog 字段：按缺失处理（继续轮询至超时）。
      const catalog = (next as { catalog?: WorkBuddyWebCatalog }).catalog
      if (isCatalogLive(catalog) || Date.now() - startedAt >= REFRESH_TIMEOUT_MS) return
      await new Promise(resolve => setTimeout(resolve, REFRESH_POLL_MS))
    }
  }, [fetchStatus, applyStatus])

  /** The merged refresh button: ask the host to re-pull the catalog first
   * (returns immediately), then poll the status document until the fresh
   * catalog lands or the wait times out. */
  const refreshWithCatalog = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      await control({ action: 'refresh' })
      await waitCatalogLive()
    } catch (error: unknown) {
      // refresh POST 失败也照常读一次 status：读本身可能仍是成功的。
      if (mounted.current) setNotice(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      await refresh()
      if (mounted.current) setBusy(false)
    }
  }, [control, refresh, t, waitCatalogLive])

  // Stale 目录自动刷新一次：saved/fallback 或上次失败时，后台重拉目录，
  // 用户不用按刷新。once per mount；失败只进 notice，不打扰不循环。
  const autoRefreshTried = useRef(false)
  useEffect(() => {
    if (autoRefreshTried.current) return
    if (probeKey === undefined) return
    const catalog = status.catalog
    if (catalog === undefined) return
    if (isCatalogLive(catalog)) return
    autoRefreshTried.current = true
    void refreshWithCatalog()
  }, [probeKey, status.catalog, refreshWithCatalog])

  const title = t(variant.titleKey)
  const label = status.nickname === undefined
    ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '')
    : t('signedInAs', { nickname: status.nickname })

  // 两个 ZCode 变体是完全独立的连接：coding 走普通通道扣订阅，start 走专属
  // 通道扣当日有效的专属余额——卡片呈现随变体而定，没有可切换的"模式"。
  const zcodeSide = variant.id === 'anyconnect-zcode' ? 'coding' : variant.id === 'anyconnect-zcode-sp' ? 'start' : undefined
  const isZCode = zcodeSide !== undefined
  const isStartPlanCard = zcodeSide === 'start'
  const zcodePlan = isZCode && status.credits?.accounts !== undefined
    ? (status.credits.accounts.find(a => a.remain > 0) ?? status.credits.accounts[0])
    : undefined
  // 名称口径：Start Plan 卡报活动名（如 "ZCode Trust Build"），Coding Plan 卡
  // 报订阅名（如 "GLM Coding Pro"）。都是上游给的真实名字，谁有就用谁。
  const zcodePlanName = zcodePlan
    ? (zcodePlan.planName ?? zcodePlan.packageName).replace(/\s*\((?:有效|VALID|EXPIRED|已过期)\)$/i, '')
    : undefined
  const isPlanActive = zcodePlan !== undefined && zcodePlan.remain > 0
  const displayPlanName = isStartPlanCard ? (zcodePlanName ?? t('startPlanLabel')) : zcodePlanName

  // 卡头摘要：已登录身份 + 当前积分/套餐状态，收起态下也要一眼看到。
  const headerSummary = isZCode
    ? [
        label,
        displayPlanName !== undefined
          ? `${displayPlanName} · ${t(isPlanActive ? 'codingPlanActive' : 'codingPlanExpired')}`
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
    <div className="wb-card" style={cardStyle}>
      <button
        type="button"
        className="wb-header"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={onToggle}
      >
        <span style={headTextStyle}>
          <span style={nameRowStyle}>
            <span aria-hidden="true" className="wb-dot-pulse" style={dotStyle('signed-in')} />
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
                    <span style={planNameStyle}>{displayPlanName ?? t('codingPlanLabel')}</span>
                    <span style={isPlanActive ? chipStyle : { ...chipStyle, background: 'var(--dsw-alias-bg-layer-3, rgba(128, 128, 128, 0.12))', color: 'var(--dsw-alias-label-tertiary)' }}>
                      {t(isPlanActive ? 'codingPlanActive' : 'codingPlanExpired')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="wb-btn"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => { void refreshWithCatalog() }}
                  >
                    {busy ? <><span className="wb-spin" aria-hidden="true" />{t('refreshing')}</> : t('refresh')}
                  </button>
                </div>
                <div style={planBadgeRowStyle}>
                  {isStartPlanCard ? (
                    <span style={privilegeChipStyle}><span aria-hidden="true">🎯</span> {t('planDedicatedQuota')}</span>
                  ) : (
                    <span style={privilegeChipStyle}><span aria-hidden="true">⚡</span> {t('codingPlanExtraQuota')}</span>
                  )}
                  {isStartPlanCard
                    ? <span style={planChipOffStyle}><span aria-hidden="true">🌙</span> {t('planNightFreeOff')}</span>
                    : <span style={privilegeChipStyle}><span aria-hidden="true">🌙</span> {t('codingPlanNightFree')}</span>}
                </div>
                {isStartPlanCard && zcodePlan !== undefined && zcodePlan.size > 0 ? (
                  <span style={planMetaStyle}>
                    {t('planQuotaLine', { remain: formatNumber(zcodePlan.remain), size: formatNumber(zcodePlan.size) })}
                  </span>
                ) : null}
                {/* 当日一次性池子：余额不会结转，必须显式说明——否则每日重置
                    会被读成"攒着的额度"，用户会按不存在的余额做计划。判据取上游
                    回报的 sameDay，而不是"这张卡是 Start Plan"：口径来自数据，
                    上游哪天改成可累积也会如实跟着变。 */}
                {isStartPlanCard && zcodePlan?.sameDay === true
                  ? <span style={planMetaStyle}>{t('planNoCarryOver')}</span>
                  : null}
                {zcodePlan?.expiredAt ? (
                  <span style={planMetaStyle}>
                    {t('codingPlanExpiresAt', { date: formatExpiry(zcodePlan.expiredAt) })}
                  </span>
                ) : null}
                {isStartPlanCard ? <span style={planMetaStyle}>{t('planStartNote')}</span> : null}
              </div>
              {/* 今日待领取提示：只有 Start Plan 变体的 status 才带 startPlanClaim。
                  available 是唯一需要用户动作的状态，所以只有它给醒目提示；none 是
                  "已领"（无需动作，不打扰）；unknown **绝不渲染成 none**——探测失败
                  时说"没得领"会让用户白丢一次领取机会。 */}
              {startPlanClaim !== undefined && startPlanClaim.state !== 'none' ? (
                <div style={startPlanClaim.state === 'available' ? claimBoxStyle : claimUnknownBoxStyle}>
                  {startPlanClaim.state === 'available' ? (
                    <>
                      <span style={claimTitleStyle}>
                        <span aria-hidden="true">🎁</span> {t('claimAvailable')}
                      </span>
                      <span style={planMetaStyle}>
                        {t('claimAvailableHint', { name: startPlanClaim.planName ?? t('startPlanLabel') })}
                      </span>
                      {startPlanClaim.planId !== undefined ? (
                        <span style={claimIdRowStyle}>
                          <span style={planMetaStyle}>{t('claimPlanIdLabel')}: <code style={claimCodeStyle}>{startPlanClaim.planId}</code></span>
                          <button type="button" className="wb-btn" style={buttonStyle} onClick={() => { void copyPlanId(startPlanClaim.planId ?? '') }}>
                            {copiedPlanId ? t('claimCopied') : t('claimCopy')}
                          </button>
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span style={planMetaStyle}>
                      {t('claimUnknown', { reason: startPlanClaim.reason ?? t('requestFailed') })}
                    </span>
                  )}
                </div>
              ) : null}
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
                    className="wb-btn"
                    style={buttonStyle}
                    disabled={busy}
                    onClick={() => { void refreshWithCatalog() }}
                  >
                    {busy ? <><span className="wb-spin" aria-hidden="true" />{t('refreshing')}</> : t('refresh')}
                  </button>
                </span>
              </div>
            </>
          )}
          {notice !== undefined ? <p style={{ ...errorStyle, fontSize: 12 }} role="alert">{t('refreshFailed', { message: notice })}</p> : null}
          {status.creditsError !== undefined
            ? <p style={{ ...errorStyle, fontSize: 12 }}>{t('creditsError', { message: status.creditsError })}</p>
            : null}

          {/* 空名单说明：live + 刚刚拉取 + 0 个模型，原本与"插件坏了"长得一模一样。
              现在 source=live 时明确说"上游答了空名单"——这是正常结论，不是故障；
              Start Plan 还多一句"去客户端领取后自己会更新"（快通道，≤60s）。 */}
          {status.models !== undefined && status.models.length === 0
            && status.catalog?.empty === true && status.catalog.error === undefined ? (
              <p style={summaryNoteStyle}>
                {isStartPlanCard ? t('catalogEmptyRosterStartPlan') : t('catalogEmptyRoster')}
              </p>
            ) : null}
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
                {/* 目录来源与拉取失败对用户可见:stale 与离线是不同处境,
                    不能只作内部判据(status-paths 的契约声明)。 */}
                <span style={summaryNoteStyle}>{t(catalogSourceKey(status.catalog))}</span>
                {status.catalog?.error !== undefined
                  ? <span style={{ ...summaryNoteStyle, color: 'var(--dsw-alias-state-error-primary, #ff4d4f)' }}>{t('catalogSourceError', { message: status.catalog.error })}</span>
                  : null}
              </div>
              {modelsOpen ? (
                <div style={{ width: '100%', overflowX: 'auto' }}>
                  <table style={modelTableStyle}>
                    <thead>
                      <tr>
                        <th style={{ ...modelThStyle, textAlign: 'left' }}>{t('colName')}</th>
                        <th style={modelThStyle} aria-label={t('colTags')} />
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
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
