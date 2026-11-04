/**
 * 共享 wire 契约的纯函数回归：`resolveUsageLabel` 的回退链。
 *
 * label/unit 的本地化结构由 provider 提供、由 client 按 DSH 当前语言解析：
 * 回退顺序错一步，英文用户就会看到中文、或渲染层拿到空串。这里把每一条回退
 * 分支都钉住（types.ts 的 per-file 覆盖率也依赖这些分支用例）。
 */

import { describe, expect, it } from 'vitest'
import { resolveUsageLabel, type LocalizedUsageLabel } from '../src/types.js'

describe('resolveUsageLabel', () => {
  it('纯字符串原样返回（provider 专有名词不翻译，locale 无关）', () => {
    expect(resolveUsageLabel('Total', 'zh')).toBe('Total')
    expect(resolveUsageLabel('总计', 'en')).toBe('总计')
    expect(resolveUsageLabel('', 'zh')).toBe('')
  })

  it('精确 locale 命中优先', () => {
    expect(resolveUsageLabel({ en: 'Total', zh: '总计' }, 'zh')).toBe('总计')
    expect(resolveUsageLabel({ en: 'Total', zh: '总计' }, 'en')).toBe('Total')
    // 第三种语言：先精确命中，不落到 en。
    expect(resolveUsageLabel({ en: 'Total', zh: '总计', ja: '合計' }, 'ja')).toBe('合計')
  })

  it('带地区子标签的 locale 回退到主语言（zh-CN → zh）', () => {
    expect(resolveUsageLabel({ en: 'Total', zh: '总计' }, 'zh-CN')).toBe('总计')
  })

  it('当前语言没有条目时回退 en', () => {
    expect(resolveUsageLabel({ en: 'Total', zh: '总计' }, 'fr')).toBe('Total')
    expect(resolveUsageLabel({ en: 'Total', zh: '总计' })).toBe('Total')
    expect(resolveUsageLabel({ en: 'Total', zh: '总计' }, '')).toBe('Total')
  })

  it('精确与主语言条目为空串时继续回退（空串不算命中）', () => {
    const label = { en: 'Total', zh: '' } as LocalizedUsageLabel
    expect(resolveUsageLabel(label, 'zh')).toBe('Total')
    const region = { en: 'Total', zh: '', 'zh-CN': '' } as LocalizedUsageLabel
    expect(resolveUsageLabel(region, 'zh-CN')).toBe('Total')
  })

  it('结构异常时兜底到第一个非空值，绝不返回 undefined', () => {
    // en 缺失/为空是 registry 校验会拒的形状；这里仍验证渲染层不会拿到 undefined。
    expect(resolveUsageLabel({ zh: '总计' } as unknown as LocalizedUsageLabel, 'fr')).toBe('总计')
    expect(resolveUsageLabel({ zh: '总计', ja: '合計' } as unknown as LocalizedUsageLabel)).toBe('总计')
    expect(resolveUsageLabel({} as LocalizedUsageLabel, 'en')).toBe('')
    expect(resolveUsageLabel({ en: '' } as LocalizedUsageLabel, 'en')).toBe('')
  })
})
