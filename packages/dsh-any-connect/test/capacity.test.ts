/**
 * 模型容量显式声明回归（DSH 0.2.2 契约）。
 *
 * 0.2.2-alpha.2 起宿主把「未声明容量的自定义模型」的默认上下文/最大输出改为
 * 十进制 1M / 128K（release notes「其他变更」），小端点会因此推迟压缩、请求
 * 打到上游才被拒。本插件注册的每个模型都必须自带真实容量，**不能依赖那个
 * 默认值**。
 *
 * 本测试钉住所有注册入口：
 * - 四个通道的编译期兜底名单；
 * - ZCode 未知模型的保守默认（defaultZCodeModelInfo / startPlanModelInfo）；
 * - WorkBuddy 目录行解析（缺 maxInput/maxOutput 的行必须丢弃）；
 * - `toPiModel` 把目录容量原样透传给 pi-ai 模型描述符，且 `compat` 只出现在
 *   OpenAI 形通道（官方 pi-ai 字段；见 adapter.ts 注释）。
 *
 * @module dsh-any-connect/capacity-test
 */

import { describe, expect, it } from 'vitest'
import { toPiModel } from '../src/adapter.js'
import {
  FALLBACK_OPENCODE_MODELS,
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_ZCODE_MODELS,
} from '../src/catalog.js'
import type { WorkBuddyModelInfo } from '../src/catalog.js'
import { FALLBACK_ZCODE_START_PLAN_MODELS, startPlanModelInfo } from '../src/zcode-plan-models.js'
import { defaultZCodeModelInfo } from '../src/upstream-zcode-body.js'
import { parseModelRow } from '../src/upstream-workbuddy-parse.js'

/** 一个可注册模型的容量必须显式为正的有限整数。 */
function expectExplicitCapacity(info: WorkBuddyModelInfo): void {
  expect(Number.isInteger(info.contextWindow), `${info.id} contextWindow`).toBe(true)
  expect(info.contextWindow).toBeGreaterThan(0)
  expect(Number.isInteger(info.maxTokens), `${info.id} maxTokens`).toBe(true)
  expect(info.maxTokens).toBeGreaterThan(0)
}

describe('模型容量显式声明', () => {
  it('四个通道的编译期兜底名单每行都带显式容量', () => {
    const rosters: Record<string, readonly WorkBuddyModelInfo[]> = {
      workbuddy: FALLBACK_WORKBUDDY_MODELS,
      'workbuddy-ai': FALLBACK_WORKBUDDY_AI_MODELS,
      zcode: FALLBACK_ZCODE_MODELS,
      'zcode-start-plan': FALLBACK_ZCODE_START_PLAN_MODELS,
      'opencode-free': FALLBACK_OPENCODE_MODELS,
    }
    for (const [name, roster] of Object.entries(rosters)) {
      expect(roster.length, `${name} 兜底名单不应为空`).toBeGreaterThan(0)
      for (const info of roster) expectExplicitCapacity(info)
    }
  })

  it('无目录信息的未知模型走保守默认（200K / 32K），绝不落到宿主 1M/128K 默认', () => {
    const zcode = defaultZCodeModelInfo('brand-new-model')
    expectExplicitCapacity(zcode)
    expect(zcode.contextWindow).toBeLessThan(1_000_000)
    expect(zcode.maxTokens).toBeLessThan(128_000)

    const startPlan = startPlanModelInfo('brand-new-plan-model')
    expectExplicitCapacity(startPlan)
    expect(startPlan.contextWindow).toBeLessThan(1_000_000)
    expect(startPlan.maxTokens).toBeLessThan(128_000)
  })

  it('WorkBuddy 目录解析：缺少/非正的 maxInput 或 maxOutput 直接丢弃（不产生无容量行）', () => {
    const base = { id: 'm', name: 'M', supportsImages: false }
    expect(parseModelRow(base, false, undefined)).toBeUndefined()
    expect(parseModelRow({ ...base, maxInputTokens: 0, maxOutputTokens: 100 }, false, undefined)).toBeUndefined()
    expect(parseModelRow({ ...base, maxInputTokens: 100, maxOutputTokens: 0 }, false, undefined)).toBeUndefined()

    const parsed = parseModelRow({ ...base, maxInputTokens: 200_000, maxOutputTokens: 32_000 }, false, undefined)
    expect(parsed).toBeDefined()
    expectExplicitCapacity(parsed as WorkBuddyModelInfo)
    expect((parsed as WorkBuddyModelInfo).contextWindow).toBe(200_000)
    expect((parsed as WorkBuddyModelInfo).maxTokens).toBe(32_000)
  })

  it('toPiModel 把目录容量原样透传给 pi-ai 描述符（不漏成 undefined）', () => {
    const info: WorkBuddyModelInfo = {
      id: 'small', name: 'Small', contextWindow: 200_000, maxTokens: 32_000, supportsImages: false,
    }
    const model = toPiModel(info, 'http://127.0.0.1:1/v1', 'workbuddy', 'openai-completions')
    expect(model.contextWindow).toBe(200_000)
    expect(model.maxTokens).toBe(32_000)
  })

  it('compat.supportsDeveloperRole 只对 OpenAI 形通道声明（官方 pi-ai Model.compat）', () => {
    const info: WorkBuddyModelInfo = {
      id: 'm', name: 'M', contextWindow: 200_000, maxTokens: 32_000, supportsImages: false,
    }
    const openai = toPiModel(info, 'http://127.0.0.1:1/v1', 'workbuddy', 'openai-completions')
    expect(openai.compat).toEqual({ supportsDeveloperRole: false })
    const anthropic = toPiModel(info, 'http://127.0.0.1:1', 'zcode', 'anthropic-messages')
    expect(anthropic.compat).toBeUndefined()
  })
})
