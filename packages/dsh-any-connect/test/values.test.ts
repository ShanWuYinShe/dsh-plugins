import { describe, expect, it } from 'vitest'
import { errorMessage, isObject, safeMessage } from '../src/values.js'

/**
 * 过线脱敏的唯一实现（2026-10-30 从 web-status.ts 迁入 values.ts）：宿主状态
 * 路由、探针路由与回环 shim 的错误体共用。行为变化点在 shim——三处错误体原先
 * 直接 `String(error)` 写回，现统一走这里；本文件锁住规则集本身。
 */
describe('safeMessage', () => {
  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl'
    expect(safeMessage(new Error(`upstream rejected ${jwt}`))).toBe('upstream rejected [redacted token]')
  })

  it('redacts token-like query parameters but keeps the parameter name', () => {
    expect(safeMessage(new Error('refresh failed: code=abc123&access_token=SECRET&api_key=KEY')))
      .toBe('refresh failed: code=[redacted]&access_token=[redacted]&api_key=[redacted]')
  })

  it('takes the message off an Error and String() otherwise', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('boom')).toBe('boom')
  })

  it('truncates to 500 characters', () => {
    expect(safeMessage('x'.repeat(600))).toHaveLength(500)
  })

  it('keeps ordinary error text intact', () => {
    expect(safeMessage(new Error('HTTP_403 auth_forbidden'))).toBe('HTTP_403 auth_forbidden')
  })

  it('isObject guards plain object records only', () => {
    expect(isObject({})).toBe(true)
    expect(isObject([])).toBe(false)
    expect(isObject(null)).toBe(false)
  })
})
