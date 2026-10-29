import { describe, expect, it } from 'vitest'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import { deadlineSignal, withTimeout } from '../src/timeout.js'

/**
 * 超时抽象回归：`src/timeout.ts` 现在是宿主 `@deepseek-ai/dsh-timeout` 的
 * deadline 薄封装（静态 import，外部插件由宿主 runtime resolution 供给同一份
 * 模块）。这里钉住三件事：
 * - 超时 abort 的原因能被宿主 `timeoutOf` 按 code 分类（即真的走了宿主实现）；
 * - 上游取消原样透传（不等超时）；
 * - `withTimeout` 在结束后拆 timer（当前实现 dispose 拆 timer，signal 不再触发）
 *   并透传返回值。
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('deadlineSignal（宿主 dsh-timeout）', () => {
  it('超时 abort 且原因可被 timeoutOf 按 code 识别', async () => {
    const handle = await deadlineSignal(undefined, 15, 'TEST_CODE')
    expect(handle.signal.aborted).toBe(false)
    await sleep(60)
    expect(handle.signal.aborted).toBe(true)
    // 能被宿主 taxonomy 识别 = 走的是宿主 TimeoutReason，而不是本地回退。
    expect(timeoutOf(handle.signal, 'TEST_CODE')?.code).toBe('TEST_CODE')
    handle.dispose()
  })

  it('上游取消透传（不等超时）', async () => {
    const upstream = new AbortController()
    const handle = await deadlineSignal(upstream.signal, 10_000, 'TEST_CODE')
    upstream.abort(new Error('caller gone'))
    await sleep(10)
    expect(handle.signal.aborted).toBe(true)
    // 上游原因原样透传，不是超时原因。
    expect(timeoutOf(handle.signal, 'TEST_CODE')).toBeUndefined()
    handle.dispose()
  })

  it('dispose 后 timer 不再触发', async () => {
    const handle = await deadlineSignal(undefined, 15, 'TEST_CODE')
    handle.dispose()
    await sleep(60)
    expect(handle.signal.aborted).toBe(false)
  })

  it('非正超时时不设 timer，只融合上游取消（宿主 sentinel 语义）', async () => {
    const upstream = new AbortController()
    const handle = await deadlineSignal(upstream.signal, 0, 'TEST_CODE')
    expect(handle.signal).toBe(upstream.signal)
    handle.dispose()
    await sleep(20)
    expect(upstream.signal.aborted).toBe(false)
  })
})

describe('withTimeout', () => {
  it('透传结果并在结束后拆 timer', async () => {
    const value = await withTimeout(undefined, 1000, 'TEST_CODE', async (signal) => {
      expect(signal.aborted).toBe(false)
      return 42
    })
    expect(value).toBe(42)
  })

  it('观测 signal 的回调在超时后收到 abort（notify-only 语义）', async () => {
    await expect(withTimeout(undefined, 15, 'TEST_CODE', async (signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })).rejects.toThrow()
  })
})
