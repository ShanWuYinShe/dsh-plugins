import type { ReactNode } from 'react'

export interface ModelLabelProps {
  provider: { id: string; name: string }
  model: { id: string; name: string; [key: string]: unknown }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}

const RATE_SEPARATOR = ' · '

type BadgeCategory = 'free' | 'high' | 'normal' | 'info'

/** Provider-authored catalog badge shape (DSH 0.2.2 `LlmModelBadge`). */
interface NativeBadge {
  text: string | Record<string, string>
  tone?: 'neutral' | 'info' | 'success' | 'warning'
}

function readNativeBadge(model: ModelLabelProps['model']): NativeBadge | undefined {
  const badge = (model as { badge?: unknown }).badge
  if (badge === null || typeof badge !== 'object') return undefined
  const candidate = badge as NativeBadge
  if (typeof candidate.text === 'string') return candidate.text.length > 0 ? candidate : undefined
  if (candidate.text === null || typeof candidate.text !== 'object') return undefined
  return candidate
}

/**
 * Resolve one provider-authored badge text for the active UI language.
 *
 * The host's own selector resolves through its locale service, whose
 * `resolveText` seat belongs to the slot owner and is not part of the label
 * props. The host locale client mirrors the active language onto
 * `document.documentElement.lang`, so that mirror is the primary source;
 * the browser language and English follow as fallbacks.
 */
function resolveBadgeText(text: string | Record<string, string>): string {
  if (typeof text === 'string') return text
  const documentLanguage = typeof document !== 'undefined' ? document.documentElement.lang : ''
  const browserLanguage = typeof navigator !== 'undefined' ? navigator.language : ''
  const language = documentLanguage || browserLanguage
  const base = language.toLowerCase().split('-')[0] ?? ''
  return text[base] ?? text['en'] ?? Object.values(text)[0] ?? ''
}

function toneCategory(tone: NativeBadge['tone']): BadgeCategory {
  if (tone === 'success') return 'free'
  if (tone === 'warning') return 'high'
  if (tone === 'info') return 'info'
  return 'normal'
}

function parseRateCategory(rate: string): BadgeCategory {
  const normalized = rate.trim().toLowerCase()
  if (normalized === '免费' || normalized === 'free' || normalized === 'x0' || normalized === 'x0.0' || normalized === 'x0.00') {
    return 'free'
  }
  const matchX = normalized.match(/^x([0-9]+(?:\.[0-9]+)?)/)
  if (matchX && parseFloat(matchX[1] ?? '0') >= 2.0) {
    return 'high'
  }
  const matchPercent = normalized.match(/([0-9]+(?:\.[0-9]+)?)%/)
  if (matchPercent && parseFloat(matchPercent[1] ?? '0') > 100) {
    return 'high'
  }
  return 'normal'
}

/**
 * Native inline model label renderer for the `conversation.input.model.label` slot.
 *
 * DSH 0.2.2 lets a catalog entry carry a provider-authored `badge`, and the
 * host renders it itself only while no plugin contributes this slot. This
 * component therefore consumes the badge directly: the catalog badge wins
 * whenever the host supplies one (its tone drives the color), and the legacy
 * `name · rate` suffix parsed from the display name stays the fallback for
 * hosts or catalogs without badge metadata.
 *
 * The rate also stays on `name`: the `/model` popup builds its rows from
 * `model.name` alone, so dropping the suffix would hide the rate there.
 */
export function ModelLabel({ model, placement }: ModelLabelProps): ReactNode {
  const fullName = typeof model?.name === 'string' ? model.name : ''
  const parts = fullName.split(RATE_SEPARATOR)
  const baseName = parts[0] ?? fullName
  const ratePart = parts.slice(1).join(RATE_SEPARATOR).trim()

  const native = readNativeBadge(model)
  const nativeText = native === undefined ? '' : resolveBadgeText(native.text)
  const badgeText = nativeText.length > 0 ? nativeText : ratePart
  const category = nativeText.length > 0 ? toneCategory(native?.tone) : parseRateCategory(ratePart)

  if (badgeText.length === 0) {
    return fullName
  }

  const isTrigger = placement === 'trigger'

  const baseBadgeStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    flex: '0 0 auto',
    fontSize: isTrigger ? 10 : 11,
    lineHeight: '14px',
    padding: isTrigger ? '0 3px' : '0 4px',
    borderRadius: 4,
    fontWeight: 500,
    marginLeft: 4,
    verticalAlign: 'baseline',
    userSelect: 'none',
    fontVariantNumeric: 'tabular-nums',
  }

  let badgeStyle: React.CSSProperties
  if (category === 'free') {
    badgeStyle = {
      ...baseBadgeStyle,
      color: 'var(--dsw-alias-state-success-primary, #52c41a)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #52c41a) 12%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #52c41a) 30%, transparent)',
    }
  } else if (category === 'high') {
    badgeStyle = {
      ...baseBadgeStyle,
      color: 'var(--dsw-alias-state-warn-primary, #faad14)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #faad14) 14%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #faad14) 35%, transparent)',
    }
  } else if (category === 'info') {
    // 蓝色强调用 state-business-primary：主题里的 brand-primary 是近黑的中性色
    // （实测 #0f1115），拿它做「信息」徽标会渲染成一个看不出区别的深色胶囊。
    badgeStyle = {
      ...baseBadgeStyle,
      color: 'var(--dsw-alias-state-business-primary, #1677ff)',
      background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #1677ff) 10%, transparent)',
      border: '1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #1677ff) 22%, transparent)',
    }
  } else {
    badgeStyle = {
      ...baseBadgeStyle,
      color: 'var(--dsw-alias-label-secondary, #666)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))',
    }
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minWidth: 0,
        maxWidth: '100%',
      }}
      title={`${baseName} (${badgeText})`}
    >
      <span
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {baseName}
      </span>
      <span style={badgeStyle} aria-label={badgeText}>
        {badgeText}
      </span>
    </span>
  )
}
