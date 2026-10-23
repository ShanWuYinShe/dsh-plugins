/**
 * VariantCard.tsx — 单个变体卡片：账号/额度/模型/探针与领取入口。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事，
 * 页面入口与 re-export 保留在 WorkBuddyConfigPage.tsx。
 *
 * @module dsh-any-connect/client/VariantCard
 */

import { catalogSourceKey } from './config-types.js'
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
  refreshButtonStyle,
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
  dotStyle,
} from './config-styles.js'
import { formatExpiry, formatNumber } from './config-format.js'
import { ModelRow } from './ModelRow.js'

import type { CardStatus, WorkBuddyCardVariant, WorkBuddyConfigPageInjected } from './config-types.js'
import type { WorkBuddyWebStatus } from '../src/status-paths.js'
import { useVariantCard } from './useVariantCard.js'
import { StartPlanClaimBox } from './StartPlanClaimBox.js'

function CardRefreshButton({ busy, onClick, t }: { busy: boolean; onClick: () => void; t: WorkBuddyConfigPageInjected['t'] }) {
  return (
    <button
      type="button"
      className="wb-btn"
      style={{
        ...refreshButtonStyle,
        opacity: busy ? 0.65 : 1,
        cursor: busy ? 'default' : 'pointer',
      }}
      disabled={busy}
      title={busy ? t('refreshing') : t('refresh')}
      aria-label={busy ? t('refreshing') : t('refresh')}
      onClick={onClick}
    >
      <svg
        className={busy ? 'wb-spin-icon' : undefined}
        aria-hidden="true"
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'inline-block', flexShrink: 0 }}
      >
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
        <polyline points="21 3 21 8 16 8" />
      </svg>
      <span>{t('refresh')}</span>
    </button>
  )
}

export function VariantCard(props: {
  t: WorkBuddyConfigPageInjected['t']
  variant: WorkBuddyCardVariant
  status: Extract<CardStatus, { status: 'signed-in' }>
  open: boolean
  onToggle: () => void
  /** Re-read this variant's status document (caller owns state updates). */
  fetchStatus: (signal?: AbortSignal) => Promise<WorkBuddyWebStatus>
  applyStatus: (next: CardStatus) => void
}): React.ReactNode {
  const {
    t, variant, status, open, onToggle,
    busy, notice, modelsOpen, setModelsOpen, copiedPlanId,
    probe, startPlanClaim, copyPlanId, refresh,
    refreshWithCatalog, title, label, isZCode, isStartPlanCard, isOpenCode, zcodePlan, zcodePools, isPlanActive, planStateLabel, displayPlanName, headerSummary, catalogOffline, effortsOf,
    deleteModel, restoreModels,
  } = useVariantCard(props)

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
          <span style={{ ...summaryStyle, ...(catalogOffline ? { color: 'var(--dsw-alias-state-error-primary, #ff4d4f)' } : {}) }} title={t(variant.introKey)}>{headerSummary}</span>
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
                      {planStateLabel ?? t('codingPlanActive')}
                    </span>
                  </div>
                  <CardRefreshButton busy={busy} onClick={() => { void refreshWithCatalog() }} t={t} />
                </div>
                <div style={planBadgeRowStyle}>
                  {/* 不用 emoji 当图标：渲染随系统字体漂移，宿主卡片也以纯文字
                      chip 为主；语义已由文案完整承载。 */}
                  {isStartPlanCard ? (
                    <span style={privilegeChipStyle}>{t('planDedicatedQuota')}</span>
                  ) : (
                    <span style={privilegeChipStyle}>{t('codingPlanExtraQuota')}</span>
                  )}
                </div>
                {isStartPlanCard && zcodePools.length > 1 ? (
                  // 多池：每个模型一份额度，池子互不通用——逐池列出（带模型名），
                  // 只显示第一个池会让其余模型的额度整个不可见。
                  zcodePools.map(pool => (
                    <span key={pool.label} style={planMetaStyle}>
                      {t('planPoolQuotaLine', { pool: pool.label, remain: formatNumber(pool.remain), size: formatNumber(pool.size) })}
                    </span>
                  ))
                ) : isStartPlanCard && zcodePlan !== undefined && zcodePlan.size > 0 ? (
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
              <StartPlanClaimBox t={t} claim={startPlanClaim} copied={copiedPlanId} onCopy={copyPlanId} />
            </>
          ) : isOpenCode ? (
            <>
              <hr style={dividerStyle} />
              <div style={summaryRowStyle}>
                <span style={summaryLabelStyle}>{t('creditsLabel')}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={summaryValueStyle} title={status.domain}>
                    {t('openCodeFreeBadge')}
                  </span>
                  <CardRefreshButton busy={busy} onClick={() => { void refreshWithCatalog() }} t={t} />
                </span>
              </div>
            </>
          ) : (
            <>
              <hr style={dividerStyle} />
              <div style={summaryRowStyle}>
                <span style={summaryLabelStyle}>{t('creditsLabel')}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={summaryValueStyle} title={status.domain}>
                    {status.credits !== undefined
                      ? formatNumber(status.credits.total)
                      : (status.creditsError !== undefined ? '—' : t('creditsUnavailable'))}
                  </span>
                  <CardRefreshButton busy={busy} onClick={() => { void refreshWithCatalog() }} t={t} />
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
          {status.models !== undefined && (status.models.length > 0 || (status.excludedCount ?? 0) > 0) ? (
            <>
              <hr style={dividerStyle} />
              <div style={summaryHeadStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    style={summaryToggleStyle}
                    aria-expanded={modelsOpen}
                    onClick={() => { setModelsOpen(!modelsOpen) }}
                  >
                    <span aria-hidden="true" style={{ ...chevronStyle, fontSize: 14, transform: modelsOpen ? 'rotate(180deg)' : 'none' }}>⌄</span>
                    <span>{t('modelsCount', { n: status.models.length })}</span>
                  </button>
                  {(status.excludedCount ?? 0) > 0 ? (
                    <>
                      <span style={{ ...summaryNoteStyle, color: 'var(--dsw-alias-label-secondary)' }}>
                        ({t('excludedModelsCount', { n: status.excludedCount })})
                      </span>
                      <button
                        type="button"
                        className="wb-btn"
                        style={{ ...buttonStyle, minHeight: 20, padding: '1px 8px', fontSize: 11, lineHeight: '16px' }}
                        disabled={busy}
                        onClick={() => { void restoreModels() }}
                      >
                        {t('restoreDefaults')}
                      </button>
                    </>
                  ) : null}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {probe?.running === true ? <span style={summaryNoteStyle}>{t('detectingShort')}</span> : null}
                  {/* 目录来源与拉取失败对用户可见:stale 与离线是不同处境,
                      不能只作内部判据(status-paths 的契约声明)。 */}
                  <span style={summaryNoteStyle}>{t(catalogSourceKey(status.catalog))}</span>
                  {status.catalog?.error !== undefined
                    ? <span style={{ ...summaryNoteStyle, color: 'var(--dsw-alias-state-error-primary, #ff4d4f)' }}>{t('catalogSourceError', { message: status.catalog.error })}</span>
                    : null}
                </div>
              </div>
              {modelsOpen ? (
                status.models.length === 0 ? (
                  <p style={{ ...summaryNoteStyle, padding: '12px 8px' }}>{t('allModelsExcluded')}</p>
                ) : (
                  <div style={{ width: '100%', overflowX: 'auto' }}>
                    <table style={modelTableStyle}>
                      <thead>
                        <tr>
                          <th style={{ ...modelThStyle, textAlign: 'left' }}>{t('colName')}</th>
                          <th style={modelThStyle} aria-label={t('colTags')} />
                          <th style={{ ...modelThStyle, textAlign: 'right' }}>{t('colRate')}</th>
                          <th style={{ ...modelThStyle, textAlign: 'right' }}>{t('colContext')}</th>
                          <th style={{ ...modelThStyle, textAlign: 'right' }}>{t('colEfforts')}</th>
                          <th style={{ ...modelThStyle, textAlign: 'center', width: 60 }}>{t('colAction')}</th>
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
                            onRefresh={() => { void refreshWithCatalog() }}
                            onDelete={modelId => { void deleteModel(modelId) }}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
