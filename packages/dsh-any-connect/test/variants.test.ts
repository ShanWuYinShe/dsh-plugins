import { describe, expect, it } from 'vitest'
import {
  AI_VARIANT,
  CN_VARIANT,
  PROVIDER_VARIANTS,
  variantFor,
  WORKBUDDY_VARIANTS,
  ZCODE_VARIANT,
} from '../src/variants.js'

describe('AnyConnect variants', () => {
  it('declares the provider variants', () => {
    expect(WORKBUDDY_VARIANTS.map(v => v.id)).toEqual(['workbuddy', 'workbuddy-ai'])
    expect(PROVIDER_VARIANTS.map(v => v.id)).toEqual(['workbuddy', 'workbuddy-ai', 'zcode'])
    expect(CN_VARIANT.kind).toBe('workbuddy')
    expect(CN_VARIANT.region).toBe('cn')
    expect(AI_VARIANT.kind).toBe('workbuddy')
    expect(AI_VARIANT.region).toBe('global')
    expect(ZCODE_VARIANT.kind).toBe('zcode')
    expect(ZCODE_VARIANT.id).toBe('zcode')
  })

  it('keeps the providers on disjoint files, env vars, and routes', () => {
    for (let a = 0; a < PROVIDER_VARIANTS.length; a += 1) {
      for (let b = a + 1; b < PROVIDER_VARIANTS.length; b += 1) {
        const [left, right] = [PROVIDER_VARIANTS[a]!, PROVIDER_VARIANTS[b]!]
        for (const field of ['ownFilename', 'probeFilename', 'catalogFilename', 'statusPath', 'probePath', 'settingsNs'] as const) {
          expect(left[field]).not.toBe(right[field])
        }
      }
    }
    const [cn, ai] = [CN_VARIANT, AI_VARIANT]
    // env 与 desktopFilename 只在两个 WorkBuddy 变体上存在且互斥。
    for (const field of ['desktopFilename', 'env'] as const) {
      expect(cn[field]).not.toBe(ai[field])
    }
    expect(ai.desktopFilename).toBe('workbuddy-desktop-ai.info')
    expect(ai.env).toBe('WORKBUDDY_AI_AUTH_FILE')
    expect(ai.statusPath).toBe('/plugins/dsh-any-connect/ai/status')
    expect(ZCODE_VARIANT.env).toBe('ZCODE_AUTH_FILE')
    expect(ZCODE_VARIANT.statusPath).toBe('/plugins/dsh-any-connect/zcode/status')
  })

  it('looks providers up by id', () => {
    expect(variantFor('workbuddy')).toBe(CN_VARIANT)
    expect(variantFor('workbuddy-ai')).toBe(AI_VARIANT)
    expect(variantFor('zcode')).toBe(ZCODE_VARIANT)
    expect(variantFor('nope')).toBeUndefined()
  })
})
