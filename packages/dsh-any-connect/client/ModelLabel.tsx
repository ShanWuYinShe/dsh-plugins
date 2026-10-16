import type { ReactNode } from 'react'

export interface ModelLabelProps {
  provider: { id: string; name: string }
  model: { id: string; name: string; [key: string]: unknown }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}

const RATE_SEPARATOR = ' · '

function parseRateCategory(rate: string): 'free' | 'high' | 'normal' {
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
 * Native inline model label renderer for the `conversation.input.model.label` slot
 * (introduced in DSH 0.2.1-alpha.5).
 *
 * Renders cleanly separated model base name and a styled badge (e.g. green "免费",
 * amber high-rate warning, or subdued tabular-num rate "x0.34") instead of raw text
 * concatenation with middle-dots.
 */
export function ModelLabel({ provider, model, placement }: ModelLabelProps): ReactNode {
  const fullName = typeof model?.name === 'string' ? model.name : ''
  if (!fullName.includes(RATE_SEPARATOR)) {
    return fullName
  }

  const parts = fullName.split(RATE_SEPARATOR)
  const baseName = parts[0] ?? fullName
  const ratePart = parts.slice(1).join(RATE_SEPARATOR).trim()

  if (!ratePart) {
    return baseName
  }

  const category = parseRateCategory(ratePart)
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
      title={`${baseName} (${ratePart})`}
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
      <span style={badgeStyle} aria-label={ratePart}>
        {ratePart}
      </span>
    </span>
  )
}
