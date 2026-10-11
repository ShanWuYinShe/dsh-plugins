import { describe, expect, it } from 'vitest'
import { applyDefaultEffort, defaultFallbackEffort } from '../src/reasoning-default.js'
import type { WorkBuddyModelInfo } from '../src/catalog.js'

/**
 * 「默认」档的回落规则（用户指定 2026-10-11）：模型没有非思考状态
 * （`onlyReasoning: true`）时，「不发 reasoning_effort」实测等于不思考，
 * 所以改为下发 high；没有 high 就用可用档位里的最高一档。
 */
describe('defaultFallbackEffort', () => {
  function model(reasoning: WorkBuddyModelInfo['reasoning']): WorkBuddyModelInfo {
    return {
      id: 'm', name: 'M', contextWindow: 1000, maxTokens: 100, supportsImages: false,
      ...(reasoning === undefined ? {} : { reasoning }),
    } as WorkBuddyModelInfo
  }

  it('uses high when the declared set has it', () => {
    expect(defaultFallbackEffort(model({
      supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true,
    }))).toBe('high')
  })

  it('falls back to the highest available level when high is absent', () => {
    expect(defaultFallbackEffort(model({
      supports: true, onlyReasoning: true, supportedEfforts: ['low', 'medium'], defaultEffort: 'low', canDisableThinking: false,
    }))).toBe('medium')
    expect(defaultFallbackEffort(model({
      supports: true, onlyReasoning: true, supportedEfforts: ['low', 'max'], defaultEffort: 'low', canDisableThinking: false,
    }))).toBe('max')
  })

  it('uses the declared default effort for an old-form row', () => {
    expect(defaultFallbackEffort(model({
      supports: true, onlyReasoning: true, defaultEffort: 'medium', canDisableThinking: false,
    }))).toBe('medium')
    expect(defaultFallbackEffort(model({
      supports: true, onlyReasoning: true, canDisableThinking: false,
    }))).toBe('high')
  })

  it('stays silent when the model has a non-thinking state', () => {
    // onlyReasoning: false —— 不发字段就是它真正的默认，补一个档位反而改语义。
    expect(defaultFallbackEffort(model({
      supports: true, onlyReasoning: false, supportedEfforts: ['low', 'high'], defaultEffort: 'high', canDisableThinking: true,
    }))).toBeUndefined()
  })

  it('stays silent for non-reasoning or unknown models', () => {
    expect(defaultFallbackEffort(model({ supports: false, onlyReasoning: false, canDisableThinking: true }))).toBeUndefined()
    expect(defaultFallbackEffort(model(undefined))).toBeUndefined()
    expect(defaultFallbackEffort(undefined)).toBeUndefined()
  })
})

describe('applyDefaultEffort', () => {
  const info = {
    id: 'only-thinking', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: false,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high'] as const, defaultEffort: 'high' as const, canDisableThinking: false },
  }

  it('adds the fallback to a request that carries no effort', () => {
    const out = JSON.parse(applyDefaultEffort(
      JSON.stringify({ model: 'only-thinking', messages: [] }),
      (id) => (id === 'only-thinking' ? info : undefined),
    )) as Record<string, unknown>
    expect(out['reasoning_effort']).toBe('high')
  })

  it('never touches an explicit effort', () => {
    const source = JSON.stringify({ model: 'only-thinking', reasoning_effort: 'low', messages: [] })
    expect(applyDefaultEffort(source, () => info)).toBe(source)
  })

  it('returns inputs it must not rewrite unchanged', () => {
    const cases = [
      'not json',
      '"a string"',
      '[1,2,3]',
      JSON.stringify({ model: 'unknown-model', messages: [] }),
      JSON.stringify({ messages: [] }),
    ]
    for (const source of cases) {
      expect(applyDefaultEffort(source, (id) => (id === 'only-thinking' ? info : undefined))).toBe(source)
    }
  })
})
