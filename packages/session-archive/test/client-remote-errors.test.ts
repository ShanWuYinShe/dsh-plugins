import { describe, expect, it } from 'vitest'
import { remoteErrorMessage } from '../client/archive-entries.js'
import type { TFunc } from '../client/locales.js'

/** 按键回显的 t 桩：断言映射到哪个 locale 键，不重复文案本身。 */
const t: TFunc = ((key: string) => '[' + key + ']') as TFunc

/** 构造带稳定 code 的 Remote 调用失败（client/index.tsx 的 call 抛出的形状）。 */
function remoteFailure(code: string, message = 'technical text'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

/**
 * SA-10 调用侧错误本地化回归：按稳定 code 映射 locale 文案，未知 code
 * 回退「技术文本 + code」，本地异常（无 code）保留技术文本。
 */
describe('remoteErrorMessage', () => {
  it('session-archive/not-archived → errorNotArchived', () => {
    expect(remoteErrorMessage(t, remoteFailure('session-archive/not-archived'))).toBe('[errorNotArchived]')
  })

  it('remote-access/denied → errorDenied', () => {
    expect(remoteErrorMessage(t, remoteFailure('remote-access/denied'))).toBe('[errorDenied]')
  })

  it('gateway/cancelled → errorCancelled', () => {
    expect(remoteErrorMessage(t, remoteFailure('gateway/cancelled'))).toBe('[errorCancelled]')
  })

  it('未知 code 回退「errorUnknown + 技术文本 + code」', () => {
    const text = remoteErrorMessage(t, remoteFailure('gateway/internal', 'boom'))
    expect(text).toContain('[errorUnknown]')
    expect(text).toContain('boom')
    expect(text).toContain('gateway/internal')
  })

  it('本地异常（无 code）保留技术文本，不误报为远端失败', () => {
    expect(remoteErrorMessage(t, new Error('network down'))).toBe('network down')
    expect(remoteErrorMessage(t, 'plain string')).toBe('plain string')
    expect(remoteErrorMessage(t, undefined)).toBe('error')
  })
})
