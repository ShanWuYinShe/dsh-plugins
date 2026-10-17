/**
 * VariantsPage.tsx — 变体卡片列表页（只负责渲染）。
 *
 * 状态与取数见 ./useVariantsPage.js（2026-10-08 拆出）。
 *
 * @module dsh-any-connect/client/VariantsPage
 */

import { CARD_VARIANTS } from './config-types.js'
import { hintStyle } from './config-styles.js'
import { VariantCard } from './VariantCard.js'
import { SignedOutRow } from './SignedOutRow.js'
import type { WorkBuddyConfigPageInjected } from './config-types.js'
import { useVariantsPage } from './useVariantsPage.js'

export function VariantsPage({ t }: { t: WorkBuddyConfigPageInjected['t'] }): React.ReactNode {
  const { anySignedIn, applyOne, fetchOne, loaded, openIds, retryOne, statuses, toggleOpen } = useVariantsPage(t)

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
        return <SignedOutRow key={variant.id} t={t} variant={variant} status={status} onRetry={() => retryOne(variant)} />
      })}
    </div>
  )
}
