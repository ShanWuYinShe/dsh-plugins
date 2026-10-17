/**
 * StartPlanClaimBox.tsx — Start Plan「今日待领取」提示框。
 *
 * 2026-10-08 从 422 行的 VariantCard.tsx 拆出：available 给醒目提示与复制按钮，
 * unknown 如实说明探测失败原因，none 不渲染（已领，不打扰）。
 *
 * @module dsh-any-connect/client/StartPlanClaimBox
 */

import {
  buttonStyle,
  planMetaStyle,
  claimBoxStyle,
  claimUnknownBoxStyle,
  claimTitleStyle,
  claimIdRowStyle,
  claimCodeStyle,
} from './config-styles.js'
import type { WorkBuddyWebStartPlanClaim } from '../src/status-paths.js'
import type { WorkBuddyConfigPageInjected } from './config-types.js'

export function StartPlanClaimBox({ t, claim, copied, onCopy }: {
  t: WorkBuddyConfigPageInjected['t']
  claim: WorkBuddyWebStartPlanClaim | undefined
  /** 计划 id 是否已复制（按钮文案切换）。 */
  copied: boolean
  onCopy: (planId: string) => void
}): React.ReactNode {
  // none 是「已领」（无需动作，不打扰）；unknown **绝不渲染成 none**——探测失败时说
  // 「没得领」会让用户白丢一次领取机会。
  if (claim === undefined || claim.state === 'none') return null

  return (
    <div style={claim.state === 'available' ? claimBoxStyle : claimUnknownBoxStyle}>
      {claim.state === 'available' ? (
        <>
          <span style={claimTitleStyle}>{t('claimAvailable')}</span>
          <span style={planMetaStyle}>
            {t('claimAvailableHint', { name: claim.planName ?? t('startPlanLabel') })}
          </span>
          {claim.planId !== undefined ? (
            <span style={claimIdRowStyle}>
              <span style={planMetaStyle}>{t('claimPlanIdLabel')}: <code style={claimCodeStyle}>{claim.planId}</code></span>
              <button type="button" className="wb-btn" style={buttonStyle} onClick={() => { void onCopy(claim.planId ?? '') }}>
                {copied ? t('claimCopied') : t('claimCopy')}
              </button>
            </span>
          ) : null}
        </>
      ) : (
        <span style={planMetaStyle}>
          {t('claimUnknown', { reason: claim.reason ?? t('requestFailed') })}
        </span>
      )}
    </div>
  )
}
