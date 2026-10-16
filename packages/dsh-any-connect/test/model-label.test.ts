import { describe, expect, it } from 'vitest'
import React from 'react'
import { ModelLabel } from '../client/ModelLabel.js'

describe('ModelLabel client component', () => {
  it('returns plain string when model name has no rate separator', () => {
    const res = ModelLabel({
      provider: { id: 'deepseek', name: 'DeepSeek' },
      model: { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      placement: 'trigger',
      selected: false,
    })
    expect(res).toBe('DeepSeek Chat')
  })

  it('handles empty or non-string model name gracefully', () => {
    const res = ModelLabel({
      provider: { id: 'test', name: 'Test' },
      model: { id: 'test-model', name: '' },
      placement: 'menu',
      selected: false,
    })
    expect(res).toBe('')
  })

  it('splits baseName and renders a green badge for 免费 models', () => {
    const el = ModelLabel({
      provider: { id: 'opencode', name: 'OpenCode' },
      model: { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash · 免费' },
      placement: 'option',
      selected: true,
    }) as React.ReactElement<any>

    expect(React.isValidElement(el)).toBe(true)
    const children = React.Children.toArray(el.props.children) as Array<React.ReactElement<any>>
    expect(children).toHaveLength(2)

    // Base name
    expect(children[0]?.props.children).toBe('GLM-5.3-Flash')
    // Badge
    expect(children[1]?.props.children).toBe('免费')
    expect(children[1]?.props.style.color).toContain('var(--dsw-alias-state-success-primary')
  })

  it('splits baseName and renders a subdued tabular badge for credit multipliers (e.g. x0.34)', () => {
    const el = ModelLabel({
      provider: { id: 'workbuddy', name: 'WorkBuddy' },
      model: { id: 'fast-model', name: 'Fast · x0.34' },
      placement: 'trigger',
      selected: true,
    }) as React.ReactElement<any>

    expect(React.isValidElement(el)).toBe(true)
    const children = React.Children.toArray(el.props.children) as Array<React.ReactElement<any>>
    expect(children).toHaveLength(2)

    expect(children[0]?.props.children).toBe('Fast')
    expect(children[1]?.props.children).toBe('x0.34')
    expect(children[1]?.props.style.fontSize).toBe(10) // trigger placement is more compact
    expect(children[1]?.props.style.fontVariantNumeric).toBe('tabular-nums')
  })

  it('supports other badge text like 150% 额度 in option placement', () => {
    const el = ModelLabel({
      provider: { id: 'zcode', name: 'ZCode' },
      model: { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet · 150% 额度' },
      placement: 'option',
      selected: false,
    }) as React.ReactElement<any>

    expect(React.isValidElement(el)).toBe(true)
    const children = React.Children.toArray(el.props.children) as Array<React.ReactElement<any>>
    expect(children).toHaveLength(2)

    expect(children[0]?.props.children).toBe('Claude 3.7 Sonnet')
    expect(children[1]?.props.children).toBe('150% 额度')
    expect(children[1]?.props.style.fontSize).toBe(11) // option placement is 11px
    expect(children[1]?.props.style.color).toContain('var(--dsw-alias-state-warn-primary')
  })

  it('sets title tooltip and anti-squeeze flex rules on elements', () => {
    const el = ModelLabel({
      provider: { id: 'workbuddy', name: 'WorkBuddy' },
      model: { id: 'expensive', name: 'Expensive · x3.5' },
      placement: 'trigger',
      selected: false,
    }) as React.ReactElement<any>

    expect(el.props.title).toBe('Expensive (x3.5)')
    const children = React.Children.toArray(el.props.children) as Array<React.ReactElement<any>>
    // Name shrinks, badge does not
    expect(children[0]?.props.style.flex).toBe('1 1 auto')
    expect(children[1]?.props.style.flex).toBe('0 0 auto')
    expect(children[1]?.props.style.color).toContain('var(--dsw-alias-state-warn-primary')
  })
})
