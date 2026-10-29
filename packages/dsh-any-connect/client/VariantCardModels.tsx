/**
 * VariantCardModels.tsx — 卡片「模型」区块：可见模型表、隐藏模型区与空名单说明。
 *
 * 2026-10-29 从 380 行的 VariantCard.tsx 拆出：两张表与空名单/隐藏区是卡片里最长
 * 的一段，单独成文件后 VariantCard 只剩卡头与组合。
 *
 * @module dsh-any-connect/client/VariantCardModels
 */

import {
  buttonStyle,
  chevronStyle,
  dividerStyle,
  modelTableStyle,
  modelThStyle,
  summaryHeadStyle,
  summaryNoteStyle,
  summaryToggleStyle,
} from './config-styles.js'
import { catalogSourceKey } from './config-types.js'
import { ModelRow } from './ModelRow.js'
import type { VariantCardView } from './useVariantCard.js'

/** 模型区块：空名单说明 + 可见模型表 + 已隐藏模型区。 */
export function VariantCardModels({ card }: { card: VariantCardView }): React.ReactNode {
  const { t, status, probe, busy, modelsOpen, setModelsOpen, excludedOpen, setExcludedOpen, excludedModels, deleteModel, restoreModel, restoreModels, refreshWithCatalog, view } = card
  const { effortsOf } = view
  return (
    <>
      {/* 空名单说明：live + 刚刚拉取 + 0 个模型，原本与"插件坏了"长得一模一样。
          现在 source=live 时明确说"上游答了空名单"——这是正常结论，不是故障；
          Start Plan 还多一句"去客户端领取后自己会更新"（快通道，≤60s）。 */}
      {status.models !== undefined && status.models.length === 0
        && status.catalog?.empty === true && status.catalog.error === undefined ? (
          <p style={summaryNoteStyle}>
            {view.isStartPlanCard ? t('catalogEmptyRosterStartPlan') : t('catalogEmptyRoster')}
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
                  {/* 「全部恢复」保留但降级为次要出口：主路径是下面隐藏区里的
                      逐条恢复。加 title 说清影响范围，避免用户以为它只影响某一个。 */}
                  <button
                    type="button"
                    className="wb-btn"
                    style={{ ...buttonStyle, minHeight: 20, padding: '1px 8px', fontSize: 11, lineHeight: '16px' }}
                    disabled={busy}
                    title={t('restoreDefaultsHint')}
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
          {/* 隐藏区：让用户看见自己隐藏了什么，并**逐条**恢复。
              此前只有「一键恢复全部」——多数情况只想放回其中一两个，
              全恢复后还得把其余重新隐藏一遍（用户报告的痛点）。 */}
          {excludedModels.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <div style={{ ...summaryHeadStyle, gap: 8 }}>
                <button
                  type="button"
                  style={summaryToggleStyle}
                  aria-expanded={excludedOpen}
                  onClick={() => { setExcludedOpen(!excludedOpen) }}
                >
                  <span aria-hidden="true" style={{ ...chevronStyle, fontSize: 14, transform: excludedOpen ? 'rotate(180deg)' : 'none' }}>⌄</span>
                  <span>{t('excludedSectionTitle', { n: excludedModels.length })}</span>
                </button>
              </div>
              {excludedOpen ? (
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
                      {excludedModels.map((row, i) => (
                        <ModelRow
                          key={row.id}
                          row={row}
                          t={t}
                          efforts={effortsOf(row)}
                          even={i % 2 === 1}
                          onRestore={modelId => { void restoreModel(modelId) }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  )
}
