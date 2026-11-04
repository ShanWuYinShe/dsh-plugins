import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { DEFAULT_CONFIG, normalizeConfig } from '../src/plugin-config.js'

/** 负向用例故意传非法形状：把 schema 收成宽签名，避免把测试意图压成类型错误。 */
const parseLoose = Config as unknown as (input: Record<string, unknown>) => Record<string, unknown>

/**
 * 配置面回归（SA-18）：入口导出的 Config schema 与 DEFAULT_CONFIG 同源，
 * 三个字段默认 200/2000/4 且只接受正整数；normalizeConfig 作为绕过 Loader
 * 的最终防线时对非法值逐项告警并回退默认值（不再静默）。
 */
describe('Config schema', () => {
  it('空配置补全默认值，且与 DEFAULT_CONFIG 同源（200/2000/4）', () => {
    expect(Config({})).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG.detailMaxMessages).toBe(200)
    expect(DEFAULT_CONFIG.messagePreviewChars).toBe(2000)
    expect(DEFAULT_CONFIG.titleReadConcurrency).toBe(4)
  })

  it('合法覆盖值原样保留', () => {
    expect(Config({ detailMaxMessages: 5, messagePreviewChars: 50, titleReadConcurrency: 2 })).toEqual({
      detailMaxMessages: 5,
      messagePreviewChars: 50,
      titleReadConcurrency: 2,
    })
  })

  it('0 / 负数 / 小数 / 字符串等非法值 fail loud（Loader 激活前拒绝）', () => {
    for (const invalid of [0, -5, 1.5, '200']) {
      expect(() => parseLoose({ detailMaxMessages: invalid }), String(invalid)).toThrow()
    }
  })
})

describe('normalizeConfig 最终防线（不静默回退）', () => {
  it('非法值回退默认并逐项告警（含原始值）', () => {
    const warnings: string[] = []
    const cfg = normalizeConfig(
      { detailMaxMessages: -5, messagePreviewChars: 'abc', titleReadConcurrency: 1.5 },
      DEFAULT_CONFIG,
      (message) => warnings.push(message),
    )
    expect(cfg).toEqual(DEFAULT_CONFIG)
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('detailMaxMessages')
    expect(warnings[0]).toContain('-5')
    expect(warnings[1]).toContain('messagePreviewChars')
    expect(warnings[2]).toContain('titleReadConcurrency')
  })

  it('合法值原样返回且不告警', () => {
    const warnings: string[] = []
    const cfg = normalizeConfig({ detailMaxMessages: 7, messagePreviewChars: 70, titleReadConcurrency: 3 }, DEFAULT_CONFIG, (message) => warnings.push(message))
    expect(cfg).toEqual({ detailMaxMessages: 7, messagePreviewChars: 70, titleReadConcurrency: 3 })
    expect(warnings).toEqual([])
  })

  it('缺失字段用默认值且不告警；非对象输入整体回退默认', () => {
    const warnings: string[] = []
    expect(normalizeConfig({}, DEFAULT_CONFIG, (message) => warnings.push(message))).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig(null, DEFAULT_CONFIG, (message) => warnings.push(message))).toEqual(DEFAULT_CONFIG)
    expect(normalizeConfig('nonsense', DEFAULT_CONFIG, (message) => warnings.push(message))).toEqual(DEFAULT_CONFIG)
    expect(warnings).toEqual([])
  })
})
