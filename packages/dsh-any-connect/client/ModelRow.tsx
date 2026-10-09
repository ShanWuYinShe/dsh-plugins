/**
 * ModelRow.tsx — 模型目录表的一行（名称、上下文/输出上限、能力与档位标签）。
 *
 * 2026-10-08 从 961 行的 WorkBuddyConfigPage.tsx 拆出：本模块只负责上面这一件事，
 * 页面入口与 re-export 保留在 WorkBuddyConfigPage.tsx。
 *
 * @module dsh-any-connect/client/ModelRow
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { WorkBuddyWebModelRow } from '../src/status-paths.js'
import type { WorkBuddyConfigPageInjected } from './config-types.js'
import {
  chipStyle,
  modelBadgesStyle,
  modelRowBaseStyle,
  modelRowEvenStyle,
  modelTdStyle,
  modelNameStyle,
  metaCellStyle,
} from './config-styles.js'
import { formatTokens, modelBadgeLabel } from './config-format.js'

/**
 * One row of the model table: name, badges, rate, context window, efforts.
 * Column widths are shared across all rows because the parent is a semantic
 * `<table>`, so tabular figures line up perfectly. Even-indexed rows get a
 * subtle background for visual grouping.
 */
export function ModelRow({ row, efforts, t, even, onRefresh }: {
  row: WorkBuddyWebModelRow
  /** The effort levels the model accepts: declared, or automatically detected. */
  efforts: readonly string[] | undefined
  t: WorkBuddyConfigPageInjected['t']
  /** Whether this is an even-indexed row (for zebra striping). */
  even: boolean
  /** 卡片级刷新动作：「价格未知」行就地给一个刷新入口，提示与动作不脱节。 */
  onRefresh?: () => void
}): React.ReactNode {
  return (
    <tr style={even ? modelRowEvenStyle : modelRowBaseStyle}>
      <td style={modelNameStyle} title={row.name}>{row.name}</td>
      <td style={modelTdStyle}>
        <span style={modelBadgesStyle}>
          {row.free === true ? <span style={chipStyle}>{t('freeModel')}</span> : null}
          {row.badges?.map((badge, index) => (
            <span key={`${badge}-${index}`} style={chipStyle}>{modelBadgeLabel(badge, t)}</span>
          ))}
        </span>
      </td>
      {/* 无 credits 也无 rateUnknown 标记的行(内置 fallback 目录即有此形态)显示「价格未知」而非无声空白——同一语义不应两种呈现。
          rateUnknown 行就地给刷新入口：提示说"刷新后更新"，动作却在表格上方摘要行，距离太远等于没说。 */}
      <td style={metaCellStyle}>
        {row.free === true ? null : row.rateUnknown === true || row.credits === undefined
          ? <>{t('rateUnknown')}{onRefresh !== undefined
              ? <button type="button" className="wb-btn" style={{ ...chipStyle, marginLeft: 6, cursor: 'pointer' }} onClick={onRefresh}>{t('refresh')}</button>
              : null}</>
          : row.credits}
      </td>
      {/* 多档模型标注其余可选窗口：改取最大档后，裸数字分不清"最大的那个"
          还是"只有一档"；单档维持原样，不制造阅读噪音。 */}
      <td style={metaCellStyle} title={row.contextWindows.length > 1 ? t('contextSmaller', { window: formatTokens(row.contextWindow), others: row.contextWindows.filter(w => w < row.contextWindow).map(formatTokens).join('/') }) : undefined}>
        {row.contextWindows.length > 1
          ? t('contextSmaller', { window: formatTokens(row.contextWindow), others: row.contextWindows.filter(w => w < row.contextWindow).map(formatTokens).join('/') })
          : formatTokens(row.contextWindow)}
      </td>
      <td style={{ ...metaCellStyle, color: 'var(--dsw-alias-label-secondary)' }}>
        {efforts !== undefined && efforts.length > 0 ? efforts.join('/') : null}
      </td>
    </tr>
  )
}
