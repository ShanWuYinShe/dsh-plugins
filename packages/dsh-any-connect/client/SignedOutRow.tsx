/**
 * SignedOutRow.tsx — 未登录态的提示行（按变体给出去哪登录的指引）。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事，
 * 页面入口与 re-export 保留在 WorkBuddyConfigPage.tsx。
 *
 * @module dsh-any-connect/client/SignedOutRow
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { useState } from 'react'
import { type WorkBuddyConfigPageInjected, type WorkBuddyCardVariant, type CardStatus } from './config-types.js'
import {
  nameStyle,
  chevronStyle,
  descriptionStyle,
  buttonStyle,
  hintStyle,
  signedOutRowStyle,
  signedOutRowHeadStyle,
  signedOutBodyStyle,
  dotStyle,
} from './config-styles.js'

/** One collapsed row per signed-out (or unreadable) variant. */
export function SignedOutRow({ t, variant, status, onRetry }: {
  t: WorkBuddyConfigPageInjected['t']
  variant: WorkBuddyCardVariant
  status: CardStatus
  /** error 态的立即重试（首拉/轮询的落定链，不经过卡片展开）。 */
  onRetry: () => void
}): React.ReactNode {
  const [open, setOpen] = useState(false)
  const title = t(variant.titleKey)
  // error 原文是英文技术串（HTTP 5xx 等）：套本地化前缀再上屏，
  // 与卡片内 refreshFailed「本地化摘要 + 技术详情」的口径一致。
  const detail = status.status === 'error'
    ? `${t('requestFailed')}: ${status.message}`
    : status.status === 'signed-out' && status.reason !== undefined
      ? status.reason
      : t(variant.signedOutHintKey)
  return (
    <div className="wb-card" style={signedOutRowStyle}>
      <button type="button" className="wb-header" style={signedOutRowHeadStyle} aria-expanded={open} onClick={() => { setOpen(!open) }}>
        <span aria-hidden="true" style={dotStyle(status.status)} />
        <span style={{ ...nameStyle, flex: '0 0 auto', fontWeight: 500 }}>{title}</span>
        <span style={{ ...descriptionStyle, flex: 1, minWidth: 0, whiteSpace: open ? 'normal' : 'nowrap', overflow: 'hidden', textOverflow: open ? 'clip' : 'ellipsis' }}>
          {status.status === 'loading' ? t('loading') : status.status === 'error' ? t('loadFailedShort') : t('signedOut')}
        </span>
        <span aria-hidden="true" style={{ ...chevronStyle, fontSize: 14, transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open ? <div style={signedOutBodyStyle}>
        <p style={hintStyle}>{detail}</p>
        {status.status === 'error' ? <div style={{ marginTop: 8 }}>
          <button type="button" className="wb-btn" style={buttonStyle} onClick={onRetry}>{t('retry')}</button>
        </div> : null}
      </div> : null}
    </div>
  )
}
