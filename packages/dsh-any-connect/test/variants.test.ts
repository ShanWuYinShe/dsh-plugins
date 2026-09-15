import { describe, expect, it } from 'vitest'
import {
  AI_VARIANT,
  CN_VARIANT,
  variantFor,
  WORKBUDDY_VARIANTS,
} from '../src/variants.js'

describe('WorkBuddy variants', () => {
  it('declares exactly the CN and international products', () => {
    expect(WORKBUDDY_VARIANTS.map(v => v.id)).toEqual(['workbuddy', 'workbuddy-ai'])
    expect(CN_VARIANT.region).toBe('cn')
    expect(AI_VARIANT.region).toBe('global')
  })

  it('keeps the two products on disjoint files, env vars, and routes', () => {
    const [cn, ai] = [CN_VARIANT, AI_VARIANT]
    for (const field of ['desktopFilename', 'ownFilename', 'catalogFilename', 'env', 'statusPath', 'settingsNs'] as const) {
      expect(cn[field]).not.toBe(ai[field])
    }
    expect(ai.desktopFilename).toBe('workbuddy-desktop-ai.info')
    expect(ai.env).toBe('WORKBUDDY_AI_AUTH_FILE')
    expect(ai.statusPath).toBe('/plugins/dsh-any-connect/ai/status')
  })

  it('looks providers up by id', () => {
    expect(variantFor('workbuddy')).toBe(CN_VARIANT)
    expect(variantFor('workbuddy-ai')).toBe(AI_VARIANT)
    expect(variantFor('nope')).toBeUndefined()
  })
})
