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
export function ModelRow({ row, efforts, t, even }: {
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
          {row.badges?.map((badge, index) => (
            <span key={`${badge}-${index}`} style={chipStyle}>{modelBadgeLabel(badge, t)}</span>
          ))}
        </span>
      </td>
      {/* 无 credits 也无 rateUnknown 标记的行(内置 fallback 目录即有此形态)显示「价格未知」而非无声空白——同一语义不应两种呈现。 */}
      <td style={metaCellStyle}>{row.free === true ? null : row.rateUnknown === true || row.credits === undefined ? t('rateUnknown') : row.credits}</td>
      <td style={metaCellStyle}>{formatTokens(row.contextWindow)}</td>
      <td style={{ ...metaCellStyle, color: 'var(--dsw-alias-label-secondary)' }}>
        {efforts !== undefined && efforts.length > 0 ? efforts.join('/') : null}
      </td>
    </tr>
  )
}
