import { describe, expect, it } from 'vitest'
import { fillStyle, formatAmount, formatReset, getDotColor } from '../client/pill-format.ts'

/**
 * pill-format 阈值回归：5%/20% 两档颜色是用户可感知的语义，
 * 改动阈值必须在这里红灯。
 */

describe('fillStyle', () => {
  it('≤5% 红色、≤20% 黄色、以上蓝色（边界含端点）', () => {
    expect(fillStyle(5).background).toContain('#ff4d4f')
    expect(fillStyle(5.1).background).toContain('#faad14')
    expect(fillStyle(20).background).toContain('#faad14')
    expect(fillStyle(20.1).background).toContain('#1677ff')
  })

  it('宽度钳在 0–100%', () => {
    expect(fillStyle(-3).width).toBe('0%')
    expect(fillStyle(140).width).toBe('100%')
    expect(fillStyle(42.5).width).toBe('42.5%')
  })
})

describe('getDotColor', () => {
  it('未查询/无快照显示灰色', () => {
    expect(getDotColor(undefined, false)).toContain('#9aa0a6')
    expect(getDotColor(undefined, true)).toContain('#9aa0a6')
  })

  it('有 error 且无 windows 显示红色', () => {
    expect(getDotColor({ provider: 'a', windows: [], fetchedAt: 1, error: 'x' }, true)).toContain('#ff4d4f')
  })

  it('remain/limit 按 5%/20% 判色，缺 remain 不判色（绿）', () => {
    const dot = (remain?: number) => getDotColor(
      { provider: 'a', windows: [{ id: 'w', label: 'W', unit: '%', limit: 100, ...remain === undefined ? {} : { remain } }], fetchedAt: 1 },
      true,
    )
    expect(dot(3)).toContain('#ff4d4f')
    expect(dot(15)).toContain('#faad14')
    expect(dot(80)).toContain('#52c41a')
    expect(dot(undefined)).toContain('#52c41a')
  })
})

describe('formatAmount', () => {
  it('整数分组、小数最多两位', () => {
    expect(formatAmount(1234567)).toBe('1,234,567')
    expect(formatAmount(3.14159)).toBe('3.14')
  })
})

describe('formatReset', () => {
  it('非法时间原样返回', () => {
    expect(formatReset('not-a-date')).toBe('not-a-date')
  })

  it('合法 ISO 返回本地化短格式（非原串）', () => {
    const out = formatReset('2026-10-01T00:00:00.000Z')
    expect(out).not.toBe('2026-10-01T00:00:00.000Z')
    expect(out.length).toBeGreaterThan(0)
  })
})
