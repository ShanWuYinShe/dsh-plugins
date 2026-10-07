/**
 * The composer-dock usage pill: the current session provider's remaining quota,
 * shown beside the harness's own turn/token pills.
 *
 * The provider comes from the harness's own per-session model directory
 * (`ctx.modelDirectories.directoryFor(sessionId).store`), which is the record
 * the composer's model seat itself renders from. That matters for correctness:
 * the durable `modelSelection` projection is empty until the session has made
 * its first request, so a pill reading only the projection would stay blank for
 * a brand-new session even though the composer already shows a concrete model.
 *
 * A provider with no querier is a normal state and reads as such — the pill
 * never invents a number, and never hides silently enough that a user wonders
 * whether the feature is broken.
 *
 * @module provider-usage/pill
 */

import { rootStyle, pillStyle, labelStyle, dotStyle, panelStyle, panelTitleStyle, noteStyle, errorStyle } from './pill-styles.js'
import { getDotColor } from './pill-format.js'
import { WindowRow } from './WindowRow.js'
import { useProviderUsage } from './useProviderUsage.js'
import type { ProviderUsagePillProps } from './pill-types.js'

// 入口（index.tsx）从本模块取注入面类型：再导出以保持既有导入路径不变。
export type { ProviderUsagePillInjected, ProviderUsagePillProps } from './pill-types.js'

/**
 * The usage pill itself.
 *
 * Rendering rules, in order: no current provider renders nothing (there is no
 * account to describe); a provider without a querier states that; a failed
 * query shows the reason; otherwise the first window's remaining figure is the
 * headline and the rest live in the expanded panel.
 */
export function ProviderUsagePill(props: ProviderUsagePillProps): React.ReactNode {
  // 没有当前 provider 就没有可描述的账号：hook 用 null 表示「不渲染」，
  // 组件原样早退（与原实现同一分支）。
  const usage = useProviderUsage(props)
  if (usage === null) return null
  const { t, provider, answer, open, setOpen, busy, stale, alignRight, setAlignRight, rootRef, buttonRef, panelRef, refresh, queried, snapshot, headlineText } = usage

  return (
    <span ref={rootRef} style={{ ...rootStyle, position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        className="pu-pill-btn"
        style={{
          ...pillStyle,
          background: open ? 'var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05))' : 'transparent',
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={headlineText}
        onClick={() => {
          if (!open && buttonRef.current) {
            // 面板默认左对齐；触发按钮靠右缘时 320px 面板会溢出视口，
            // 按按钮位置提前决定翻转（抄 useAnchoredPosition 的翻转意图）。
            const rect = buttonRef.current.getBoundingClientRect()
            setAlignRight(rect.left + 320 > window.innerWidth - 8)
          }
          setOpen(!open)
        }}
      >
        <span aria-hidden="true" style={{ ...dotStyle, background: getDotColor(snapshot, queried), opacity: stale ? 0.45 : 1 }} />
        <span style={labelStyle}>{provider}</span>
        <span style={labelStyle}>{answer === undefined ? <><span className="pu-spin" aria-hidden="true" />{headlineText}</> : headlineText}</span>
      </button>
      {open ? (
        <div ref={panelRef} tabIndex={-1} className="pu-pill-panel" style={{ ...panelStyle, outline: 'none', ...(alignRight ? { right: 0, left: 'auto' } : { left: 0 }) }} role="dialog" aria-label={t('providerUsageTitle')}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '0 0 8px' }}>
            <p style={{ ...panelTitleStyle, margin: 0 }}>{provider}{snapshot?.plan === undefined ? null : ` · ${t('plan')} ${snapshot.plan}`}</p>
            <button
              type="button"
              className="pu-pill-btn"
              style={{ ...pillStyle, border: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1))', borderRadius: 8, padding: '2px 8px', fontSize: 12, lineHeight: '18px' }}
              disabled={busy}
              title={t('refresh')}
              aria-label={t('refresh')}
              onClick={() => { void refresh() }}
            >
              {busy ? <><span className="pu-spin" aria-hidden="true" />{t('refreshing')}</> : t('refresh')}
            </button>
          </div>
          {busy ? <p style={noteStyle}>{t('refreshing')}</p> : null}
          {!queried
            ? <p style={noteStyle}>{t('noQuerierHint')}</p>
            : snapshot!.windows.length === 0
              ? <p style={noteStyle}>{snapshot!.error === undefined ? t('noWindows') : t('failed')}</p>
              : snapshot!.windows.map(window => <WindowRow key={window.id} window={window} t={t} />)}
          {queried && snapshot!.error !== undefined ? <p style={errorStyle}>{snapshot!.error}</p> : null}
        </div>
      ) : null}
    </span>
  )
}
