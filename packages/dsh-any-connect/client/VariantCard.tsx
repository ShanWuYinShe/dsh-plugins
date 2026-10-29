/**
 * VariantCard.tsx — 单个变体卡片：卡头（身份/摘要）+ 额度区块 + 模型区块。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事。
 * 2026-10-29 优雅化：额度区块与模型区块各自成文件（VariantCardQuota /
 * VariantCardModels），本文件只剩卡头与组合；派生值统一来自 useVariantCard 的
 * view（variant-card-view.ts）。
 *
 * @module dsh-any-connect/client/VariantCard
 */

import {
  cardStyle,
  headerStyle,
  headTextStyle,
  nameRowStyle,
  nameStyle,
  summaryStyle,
  chevronStyle,
  cardBodyStyle,
  errorStyle,
  dotStyle,
} from './config-styles.js'
import type { CardStatus, WorkBuddyCardVariant, WorkBuddyConfigPageInjected } from './config-types.js'
import type { WorkBuddyWebStatus } from '../src/status-paths.js'
import { useVariantCard, type VariantCardView } from './useVariantCard.js'
import { VariantCardModels } from './VariantCardModels.js'
import { VariantCardQuota } from './VariantCardQuota.js'

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
  const card: VariantCardView = useVariantCard(props)
  const { t, variant, status, open, onToggle, notice, view } = card

  return (
    <div className="wb-card" style={cardStyle}>
      <button
        type="button"
        className="wb-header"
        style={headerStyle}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${view.title}`}
        onClick={onToggle}
      >
        <span style={headTextStyle}>
          <span style={nameRowStyle}>
            <span aria-hidden="true" className="wb-dot-pulse" style={dotStyle('signed-in')} />
            <span style={nameStyle}>{view.title}</span>
          </span>
          <span style={{ ...summaryStyle, ...(view.catalogOffline ? { color: 'var(--dsw-alias-state-error-primary, #ff4d4f)' } : {}) }} title={t(variant.introKey)}>{view.headerSummary}</span>
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open ? (
        <div style={cardBodyStyle}>
          {/* 额度/限流区块（含各种上游的额度与限流展示）与模型区块各自见其文件；
              夹在中间的提示行属于整卡，留在组合层。 */}
          <VariantCardQuota card={card} />
          {notice !== undefined ? <p style={{ ...errorStyle, fontSize: 12 }} role="alert">{t('refreshFailed', { message: notice })}</p> : null}
          {status.creditsError !== undefined
            ? <p style={{ ...errorStyle, fontSize: 12 }}>{t('creditsError', { message: status.creditsError })}</p>
            : null}
          <VariantCardModels card={card} />
        </div>
      ) : null}
    </div>
  )
}
