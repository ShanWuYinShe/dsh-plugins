import { describe, expect, it } from 'vitest'
import {
  FALLBACK_ZCODE_START_PLAN_MODELS,
  isStartPlanActivityActive,
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

  it('granted=true 表示「确认没有任何授权」：空名单就是结果，不回退兜底', () => {
    // 这就是 Start Plan 那个 bug 的根因：活动列表为空（今日未领取/已过期）时
    // 回退兜底会造出三个上游根本不放行的模型，选中即 400 code 3006。
    expect(startPlanModelsFromEntitlements([], FALLBACK_ZCODE_START_PLAN_MODELS, true)).toEqual([])
    // 同上：有授权条目但一个模型都解析不出来，也不许凭空补全兜底名单。
    expect(startPlanModelsFromEntitlements([{ capabilities: ['meter:usage'] }], FALLBACK_ZCODE_START_PLAN_MODELS, true)).toEqual([])
    expect(startPlanModelsFromEntitlements([{ show_name: '   ' }], FALLBACK_ZCODE_START_PLAN_MODELS, true)).toEqual([])
    // 显式 granted=true 不能反过来吞掉真实授权。
    expect(
      startPlanModelsFromEntitlements([{ capabilities: ['model:glm-5.3-flash'] }], FALLBACK_ZCODE_START_PLAN_MODELS, true)
        .map(model => model.id),
    ).toEqual(['glm-5.3-flash'])
  })

  it('granted 保持默认 false：既有「没有授权信息就兜底」语义不变', () => {
    // 显式传 false 与不传等价——上游抖动/响应换形状时仍回退，避免分组消失。
    expect(startPlanModelsFromEntitlements([], FALLBACK_ZCODE_START_PLAN_MODELS, false))
      .toBe(FALLBACK_ZCODE_START_PLAN_MODELS)
    expect(startPlanModelsFromEntitlements([], FALLBACK_ZCODE_START_PLAN_MODELS))
      .toBe(FALLBACK_ZCODE_START_PLAN_MODELS)
  })
})

/**
 * 有效期判据：`ends_at` 是**秒级** epoch。过期活动放行的模型服务端已经不认，
 * 仍登记上去只会让用户选中后拿到 `400 code 3006 model not allowed`。
 */
describe('Start Plan 活动有效期判据', () => {
  const now = 1_790_000_000_000 // 固定时钟（毫秒），用例不依赖真实时间

  it('ends_at 已过（秒级）判为过期', () => {
    const endsAtSec = now / 1000 - 1
    expect(isStartPlanActivityActive({ status: 'active', ends_at: endsAtSec }, now)).toBe(false)
  })

  it('ends_at 未到判为有效', () => {
    const endsAtSec = now / 1000 + 60
    expect(isStartPlanActivityActive({ status: 'active', ends_at: endsAtSec }, now)).toBe(true)
  })

  it('ends_at 缺失时保守按有效处理（不能因字段缺失让用户丢名单）', () => {
    expect(isStartPlanActivityActive({ status: 'active' }, now)).toBe(true)
    expect(isStartPlanActivityActive({}, now)).toBe(true)
    // 非法数值同样按缺失处理。
    expect(isStartPlanActivityActive({ ends_at: Number.NaN }, now)).toBe(true)
  })

  it('status 非 active 一律排除，status 缺失视为 active', () => {
    expect(isStartPlanActivityActive({ status: 'expired', ends_at: now / 1000 + 60 }, now)).toBe(false)
    expect(isStartPlanActivityActive({ status: 'inactive' }, now)).toBe(false)
    expect(isStartPlanActivityActive({ status: undefined, ends_at: now / 1000 + 60 }, now)).toBe(true)
  })
})
