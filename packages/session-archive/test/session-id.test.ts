/**
 * 网关入参断言测试。
 *
 * 2026-10-08 补：session-id.ts 是 remote.ts 方法层与 typert.host.ts codec 层**共享**的同一份
 * 校验——它存在的理由就是「两层曾漂移（方法层漏了非空与上限）」。既然是安全边界上的入参校验，
 * 边界值（空串、超限）必须有直接断言，而不是只靠端到端用例顺带覆盖。
 */

import { describe, expect, it } from 'vitest'
import { assertSessionId, assertSessionIdArray } from '../src/session-id.js'

/** 与实现里的上限一致（实现未导出该常量）。 */
const LIMIT = 5000

describe('assertSessionId', () => {
  it('原样返回合法 id', () => {
    expect(assertSessionId('sess-1')).toBe('sess-1')
    expect(assertSessionId(' ')).toBe(' ') // 非空即可：空白不是本层的判据
  })

  it('拒绝空串与非字符串', () => {
    for (const bad of ['', 42, null, undefined, {}, [], true]) {
      expect(() => assertSessionId(bad)).toThrow(TypeError)
    }
  })
})

describe('assertSessionIdArray', () => {
  it('原样返回合法数组（空数组也算合法）', () => {
    expect(assertSessionIdArray([])).toEqual([])
    expect(assertSessionIdArray(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('拒绝非数组', () => {
    for (const bad of ['a', 42, null, undefined, {}]) {
      expect(() => assertSessionIdArray(bad)).toThrow(TypeError)
    }
  })

  it('任一项非法即整体拒绝（不做部分接受）', () => {
    expect(() => assertSessionIdArray(['ok', ''])).toThrow(TypeError)
    expect(() => assertSessionIdArray(['ok', 7])).toThrow(TypeError)
    expect(() => assertSessionIdArray(['ok', null])).toThrow(TypeError)
  })

  it('上限是边界：恰好 LIMIT 项通过，多一项拒绝', () => {
    const atLimit = Array.from({ length: LIMIT }, (_, index) => 's' + index)
    expect(assertSessionIdArray(atLimit)).toHaveLength(LIMIT)
    const overLimit = [...atLimit, 'extra']
    expect(() => assertSessionIdArray(overLimit)).toThrow(TypeError)
  })
})
