import { describe, expect, it } from 'vitest'
import { formatBytes, formatTime, sameItems, shortId } from '../client/archive-format.js'
import type { TFunc } from '../client/locales.js'

/** 回显键名并把 {n} 保留给调用方 replace 的 t 桩。 */
const t: TFunc = (key) => 'T:' + key + ' {n}'

/**
 * archive-format 纯函数回归：体积/时间/短 id 展示格式化与列表浅比较。
 * 这些函数被每行渲染调用，任何分支退化成 "undefined B" / 比较恒 false
 * 都会让面板显示错误或整表无谓重渲染。
 */
describe('formatBytes', () => {
  it('缺失/零体积显示占位符（不显示误导性的 0 B）', () => {
    expect(formatBytes(undefined, t)).toBe('—')
    expect(formatBytes(null, t)).toBe('—')
    expect(formatBytes(0, t)).toBe('—')
  })

  it('B / KB / MB 三档边界与小数位', () => {
    expect(formatBytes(512, t)).toBe('T:sizeBytes {n}'.replace('{n}', '512'))
    expect(formatBytes(1024, t)).toBe('T:sizeKB {n}'.replace('{n}', '1.0'))
    expect(formatBytes(1536, t)).toBe('T:sizeKB {n}'.replace('{n}', '1.5'))
    expect(formatBytes(1024 * 1024, t)).toBe('T:sizeMB {n}'.replace('{n}', '1.0'))
    expect(formatBytes(3.5 * 1024 * 1024, t)).toBe('T:sizeMB {n}'.replace('{n}', '3.5'))
  })
})

describe('formatTime', () => {
  it('合法时间戳按本地时间格式化（可解析即不抛）', () => {
    const text = formatTime(0)
    expect(text).not.toBe('0')
    expect(text.length).toBeGreaterThan(0)
  })

  it('不可解析值回退原始字符串（Invalid Date 不抛但会显示 Invalid Date）', () => {
    expect(formatTime(Number.NaN)).toBe('NaN')
  })
})

describe('shortId', () => {
  it('超长 id 截断加省略号，短 id 原样', () => {
    expect(shortId('abcdefghijkl')).toBe('abcdefghijkl')
    expect(shortId('abcdefghijklmnop')).toBe('abcdefghijkl…')
  })
})

describe('sameItems', () => {
  const row = (sessionId: string, updatedAt = 1, size = 2, live = false) => ({ sessionId, updatedAt, size, live })

  it('长度不同 → 不同', () => {
    expect(sameItems([row('a')], [])).toBe(false)
  })

  it('逐字段相同 → 相同（含同一引用快速路径）', () => {
    const a = row('a')
    expect(sameItems([a, row('b')], [a, row('b')])).toBe(true)
  })

  it('任一关键字段变化 → 不同', () => {
    expect(sameItems([row('a')], [row('a', 9)])).toBe(false)
    expect(sameItems([row('a')], [row('a', 1, 9)])).toBe(false)
    expect(sameItems([row('a')], [row('a', 1, 2, true)])).toBe(false)
    expect(sameItems([row('a')], [row('b')])).toBe(false)
  })

  it('空数组相同', () => {
    expect(sameItems([], [])).toBe(true)
  })
})
