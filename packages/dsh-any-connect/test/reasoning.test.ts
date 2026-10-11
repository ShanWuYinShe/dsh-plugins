import { describe, expect, it } from 'vitest'
import { reasoningFields } from '../src/adapter.js'
import type { WorkBuddyModelInfo } from '../src/catalog.js'

/**
 * Per-model thinking-level resolution. The DSH picker offers exactly what
 * this map enables, so its shape is the user-facing "可用思考强度" contract:
 * declared sets are honored per-model, and rows without a declared set run at
 * their built-in default only (the upstream ignores the effort field for
 * them — offering more would advertise control that does not exist).
 */
describe('reasoningFields', () => {
  function model(reasoning: WorkBuddyModelInfo['reasoning']): WorkBuddyModelInfo {
    return {
      id: 'm',
      name: 'M',
      contextWindow: 1000,
      maxTokens: 100,
      supportsImages: false,
      ...(reasoning === undefined ? {} : { reasoning }),
    } as WorkBuddyModelInfo
  }

  it('offers exactly the declared set for a new-form model', () => {
    const { reasoning, thinkingLevelMap } = reasoningFields(model({
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['low', 'high', 'xhigh'],
      defaultEffort: 'high',
      canDisableThinking: true,
    }))
    expect(reasoning).toBe(true)
    expect(thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    })
  })

  it('never maps off to a wire spelling, even when the model can disable thinking', () => {
    // 2026-10-11 实测修正：pi-ai 会把 thinkingLevelMap.off 当作「未指定档位时的
    // 下发值」注入每一条默认请求（会话标题 / auto review 都不带 effort）。而
    // 上游拒绝字符串 'off'（400 code 11150），真正关闭思考的做法是不发该字段。
    // 所以这里恒为 null：既不再污染默认请求，也不展示做不到的「Off」选项。
    const { thinkingLevelMap } = reasoningFields(model({
      supports: true,
      onlyReasoning: true,
      supportedEfforts: ['low', 'high'],
      defaultEffort: 'high',
      canDisableThinking: true,
    }))
    expect(thinkingLevelMap?.off).toBeNull()
  })

  it('offers only the default effort for an old-form model (wire value is ignored)', () => {
    const { thinkingLevelMap } = reasoningFields(model({
      supports: true,
      onlyReasoning: true,
      defaultEffort: 'medium',
      canDisableThinking: false,
    }))
    expect(thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: 'medium',
      high: null,
      xhigh: null,
      max: null,
    })
  })

  it('falls back to high for an old-form model with no default declared', () => {
    const { thinkingLevelMap } = reasoningFields(model({
      supports: true,
      onlyReasoning: true,
      canDisableThinking: false,
    }))
    expect(thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    })
  })

  it('a non-reasoning model reports no thinking at all', () => {
    expect(reasoningFields(model(undefined))).toEqual({ reasoning: false })
  })
})

describe('reasoningFields with probe observations', () => {
  it('offers verified levels for undeclared rows with a validating observation', async () => {
    const { reasoningFields } = await import('../src/adapter.js')
    const info = {
      id: 'm', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: false,
      reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high' as const, canDisableThinking: false },
    }
    const fields = reasoningFields(info, { validation: 'validating', efforts: ['low', 'max'] })
    expect(fields.reasoning).toBe(true)
    expect(fields.thinkingLevelMap).toMatchObject({ low: 'low', max: 'max', medium: null, high: null })
  })

  it('keeps the default single level on non-validating observations', async () => {
    const { reasoningFields } = await import('../src/adapter.js')
    const info = {
      id: 'm', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: false,
      reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high' as const, canDisableThinking: false },
    }
    const fields = reasoningFields(info, { validation: 'non-validating', efforts: [] })
    expect(fields.thinkingLevelMap).toMatchObject({ high: 'high', low: null })
  })

  it('never lets an observation widen or narrow a declared set', async () => {
    const { reasoningFields } = await import('../src/adapter.js')
    const info = {
      id: 'm', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: false,
      reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low'] as const, defaultEffort: 'low' as const, canDisableThinking: false },
    }
    const fields = reasoningFields(info, { validation: 'validating', efforts: ['low', 'high', 'max'] })
    expect(fields.thinkingLevelMap).toMatchObject({ low: 'low', high: null, max: null })
  })

  it('never grants off from probing', async () => {
    const { reasoningFields } = await import('../src/adapter.js')
    const info = {
      id: 'm', name: 'M', contextWindow: 1, maxTokens: 1, supportsImages: false,
      reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high' as const, canDisableThinking: true },
    }
    const fields = reasoningFields(info, { validation: 'validating', efforts: ['low'] })
    expect(fields.thinkingLevelMap).toMatchObject({ off: null, low: 'low' })
  })
})
