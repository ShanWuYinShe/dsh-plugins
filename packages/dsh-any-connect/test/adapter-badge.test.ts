import { describe, expect, it } from 'vitest'
import { modelBadge } from '../src/adapter.js'
import type { WorkBuddyModelInfo } from '../src/catalog.js'

describe('modelBadge helper', () => {
  it('assigns green success badge for free models', () => {
    const info: WorkBuddyModelInfo = {
      id: 'hy3',
      name: 'Hy3',
      contextWindow: 192000,
      maxTokens: 64000,
      supportsImages: true,
      billing: { free: true, credits: 'x0.00' },
    }
    const badge = modelBadge(info)
    expect(badge).toEqual({
      text: { en: 'Free', zh: '免费' },
      tone: 'success',
    })
  })

  it('assigns info tone badge for special promotion labels', () => {
    const info: WorkBuddyModelInfo = {
      id: 'deepseek-v4.1-flash',
      name: 'Deepseek-V4.1-Flash',
      contextWindow: 1000000,
      maxTokens: 128000,
      supportsImages: true,
      billing: { free: false, credits: 'x0.03', badges: ['独家优惠'] },
    }
    const badge = modelBadge(info)
    expect(badge).toEqual({
      text: { en: '独家优惠', zh: '独家优惠' },
      tone: 'info',
    })
  })

  it('assigns neutral tone badge for regular credits multiplier', () => {
    const info: WorkBuddyModelInfo = {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      contextWindow: 1000000,
      maxTokens: 64000,
      supportsImages: true,
      billing: { free: false, credits: 'x0.79' },
    }
    const badge = modelBadge(info)
    expect(badge).toEqual({
      text: 'x0.79',
      tone: 'neutral',
    })
  })

  it('returns undefined when billing has no free/badge/credits info', () => {
    const info: WorkBuddyModelInfo = {
      id: 'custom',
      name: 'Custom',
      contextWindow: 1000000,
      maxTokens: 64000,
      supportsImages: true,
    }
    expect(modelBadge(info)).toBeUndefined()
  })
})
