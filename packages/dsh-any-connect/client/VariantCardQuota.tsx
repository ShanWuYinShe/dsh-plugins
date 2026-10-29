/**
 * VariantCardQuota.tsx — 卡片「额度」区块：ZCode 套餐卡 / OpenCode / WorkBuddy 积分。
 *
 * 2026-10-29 从 380 行的 VariantCard.tsx 拆出：三种变体的额度展示是同一张卡里
 * 最长的互斥分支，单独成文件后 VariantCard 只剩卡头与组合。
 *
 * @module dsh-any-connect/client/VariantCardQuota
 */

import { formatExpiry, formatNumber } from './config-format.js'
import {
  dividerStyle,
  planBadgeRowStyle,
  planCardStyle,
  planMetaStyle,
  planNameStyle,
  planTitleRowStyle,
  privilegeChipStyle,
  refreshButtonStyle,
  summaryLabelStyle,
  summaryRowStyle,
  summaryValueStyle,
  chipStyle,
} from './config-styles.js'
import type { WorkBuddyConfigPageInjected } from './config-types.js'
import { RateLimitBox } from './RateLimitBox.js'
import { StartPlanClaimBox } from './StartPlanClaimBox.js'
import type { VariantCardView } from './useVariantCard.js'

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

/** 额度区块（限流块放最前：通道正在拒收请求时这是用户唯一能行动的信息）。 */
export function VariantCardQuota({ card }: { card: VariantCardView }): React.ReactNode {
  const { t, status, busy, rateLimit, refreshWithCatalog, copiedPlanId, copyPlanId, startPlanClaim, view } = card
  const { isZCode, isOpenCode, isStartPlanCard, zcodePlan, zcodePools, isPlanActive, planStateLabel, displayPlanName } = view
  return (
    <>
      {/* 限流块放最前：通道正在拒收请求时，这是用户唯一能行动的信息
          （还要等多久 / 等不到确切时间）。三个分支（ZCode/OpenCode/WorkBuddy）
          共用同一份展示，因为 429 是所有上游共有的事实。 */}
      <RateLimitBox t={t} rateLimit={rateLimit} />
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
          {/* 今日消耗统计（credit-ledger 采样差分）：裂变包每天发新包、旧包到期
              整包消失，「当前积分」每天双向跳动读不出今天花多少；这三行给一个
              稳定的今日基准。台账缺席或今日无样本时 status 不带 today，整段
              静默不渲染——降级不占位。*/}
          {status.credits?.today !== undefined ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={planMetaStyle} title={t('creditTodayEstimate', { samples: status.credits.today.samples })}>
                {t('creditTodayLine', {
                  used: formatNumber(status.credits.today.consumed),
                  granted: formatNumber(status.credits.today.granted),
                  peak: formatNumber(status.credits.today.peak),
                })}
              </span>
              {status.credits.history !== undefined && status.credits.history.length > 0 ? (
                <span style={planMetaStyle}>
                  {t('creditHistoryLine', {
                    days: status.credits.history
                      .map(day => t('creditHistoryDay', { date: day.date, used: formatNumber(day.consumed) }))
                      .join(' · '),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </>
  )
}
