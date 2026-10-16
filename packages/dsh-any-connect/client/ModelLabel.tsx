import type { ReactNode } from 'react'

export interface ModelLabelProps {
  provider: { id: string; name: string }
  model: { id: string; name: string; [key: string]: unknown }
  placement: 'trigger' | 'menu' | 'option'
  selected: boolean
}

const RATE_SEPARATOR = ' · '

/**
 * Native inline model label renderer for the `conversation.input.model.label` slot
 * (introduced in DSH 0.2.1-alpha.5).
 *
 * Renders cleanly separated model base name and a styled badge (e.g. green "免费" or
 * subdued tabular-num rate "x0.34") instead of raw text concatenation with middle-dots.
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

  const isFree = ratePart === '免费' || ratePart.toLowerCase() === 'free'
  const isTrigger = placement === 'trigger'

  const badgeStyle: React.CSSProperties = isFree
    ? {
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: isTrigger ? 10 : 11,
        lineHeight: '14px',
        padding: '0 4px',
        borderRadius: 4,
        fontWeight: 500,
        color: 'var(--dsw-alias-state-success-primary, #52c41a)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #52c41a) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary, #52c41a) 30%, transparent)',
        marginLeft: 4,
        verticalAlign: 'baseline',
      }
    : {
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: isTrigger ? 10 : 11,
        lineHeight: '14px',
        padding: '0 4px',
        borderRadius: 4,
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary, #666)',
        background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08))',
        marginLeft: 4,
        verticalAlign: 'baseline',
        fontVariantNumeric: 'tabular-nums',
      }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0, maxWidth: '100%' }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {baseName}
      </span>
      <span style={badgeStyle} aria-label={ratePart}>
        {ratePart}
      </span>
    </span>
  )
}
