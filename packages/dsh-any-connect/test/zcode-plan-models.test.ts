import { describe, expect, it } from 'vitest'
import {
  FALLBACK_ZCODE_START_PLAN_MODELS,
  startPlanModelInfo,
  startPlanModelsFromEntitlements,
} from '../src/index.js'

/**
 * Start Plan's roster follows the activity's entitlements, not the client's
 * built-in candidate list. Measured 2026-09-30 on "ZCode Trust Build": the
 * built-in catalog lists three models while the activity grants one, and the
 * other two answer `400 code 3006 model not allowed`. Registering an ungranted
 * model gives the user a selection that can only fail.
 */
describe('Start Plan 模型名单（按活动授权派生）', () => {
  it('只登记 entitlements 放行的模型', () => {
    const models = startPlanModelsFromEntitlements([
      { show_name: 'GLM-5.3-Flash', capabilities: ['model:glm-5.3-flash'] },
      { show_name: 'GLM-5.2', capabilities: ['model:glm-5.2'] },
    ])
    expect(models.map(model => model.id)).toEqual(['glm-5.3-flash', 'glm-5.2'])
  })

  it('同一模型被多条授权重复声明时只留一行（保序）', () => {
    const models = startPlanModelsFromEntitlements([
      { capabilities: ['model:glm-5.3-flash', 'model:glm-5.2'] },
      { capabilities: ['model:glm-5.3-flash'] },
    ])
    expect(models.map(model => model.id)).toEqual(['glm-5.3-flash', 'glm-5.2'])
  })

  it('capabilities 缺失时退回 show_name', () => {
    const models = startPlanModelsFromEntitlements([{ show_name: 'GLM-5.3-Flash' }])
    expect(models.map(model => model.id)).toEqual(['glm-5.3-flash'])
  })

  it('没有可用授权信息时返回兜底名单，而不是空名单', () => {
    // 空名单会让整个 Start Plan 分组从 DSH 里消失——上游抖动不该有这种后果。
    expect(startPlanModelsFromEntitlements([])).toBe(FALLBACK_ZCODE_START_PLAN_MODELS)
    expect(startPlanModelsFromEntitlements([{ show_name: '   ' }])).toBe(FALLBACK_ZCODE_START_PLAN_MODELS)
    expect(startPlanModelsFromEntitlements([{ capabilities: ['meter:usage'] }])).toBe(FALLBACK_ZCODE_START_PLAN_MODELS)
  })

  it('元数据取自客户端权威规则（窗口/输出上限）', () => {
    const flash = startPlanModelInfo('GLM-5.3-Flash')
    expect(flash.contextWindow).toBe(1000000)
    expect(flash.maxTokens).toBe(128000)
    expect(flash.supportsImages).toBe(true)
    expect(flash.reasoning?.supportedEfforts).toEqual(['low', 'high', 'max'])
    const turbo = startPlanModelInfo('GLM-5-Turbo')
    expect(turbo.contextWindow).toBe(200000)
    expect(turbo.maxTokens).toBe(64000)
  })

  it('未收录的模型走保守默认，名字保留原样', () => {
    const unknown = startPlanModelInfo('GLM-9-Future')
    expect(unknown.id).toBe('glm-9-future')
    expect(unknown.name).toBe('GLM-9-Future')
    expect(unknown.contextWindow).toBe(200000)
    expect(unknown.maxTokens).toBe(32000)
    expect(unknown.supportsImages).toBe(false)
  })

  it('派生行不带 Coding Plan 的 150%/夜间免费徽标', () => {
    for (const model of startPlanModelsFromEntitlements([{ capabilities: ['model:glm-5.3-flash'] }])) {
      expect(model.billing?.badges).toBeUndefined()
      expect(model.billing?.free).toBe(false)
    }
  })
})
