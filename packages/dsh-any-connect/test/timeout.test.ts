import { describe, expect, it } from 'vitest'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import { deadlineSignal, localDeadlineSignal, withTimeout } from '../src/timeout.js'

/**
 * 超时抽象回归：宿主 dsh-timeout 优先（可分类的 TimeoutReason code），
 * 缺席回退本地实现（同语义、普通 Error）。生产安装裁掉 devDep 时走
 * 回退，插件照常工作——两条路径语义分别钉住。
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('deadlineSignal（宿主路径）', () => {
  it('超时 abort 且原因可被 timeoutOf 按 code 识别', async () => {
    const handle = await deadlineSignal(undefined, 15, 'TEST_CODE')
    expect(handle.signal.aborted).toBe(false)
    await sleep(60)
    expect(handle.signal.aborted).toBe(true)
    // 能被宿主 taxonomy 识别=走的真实宿主实现，不是本地回退。
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
})

describe('localDeadlineSignal（回退路径）', () => {
  it('超时 abort 且原因携带 code', async () => {
    const handle = localDeadlineSignal(undefined, 15, 'TEST_CODE')
    await sleep(60)
    expect(handle.signal.aborted).toBe(true)
    expect(String(handle.signal.reason)).toContain('TEST_CODE')
    handle.dispose()
  })

  it('dispose 后 timer 不再触发', async () => {
    const handle = localDeadlineSignal(undefined, 15, 'TEST_CODE')
    handle.dispose()
    await sleep(60)
    expect(handle.signal.aborted).toBe(false)
  })

  it('上游取消透传且拆监听', async () => {
    const upstream = new AbortController()
    const handle = localDeadlineSignal(upstream.signal, 10_000, 'TEST_CODE')
    upstream.abort(new Error('caller gone'))
    await sleep(10)
    expect(handle.signal.aborted).toBe(true)
    handle.dispose()
  })

  it('非正超时不设 timer（与宿主 sentinel 语义一致）', async () => {
    const upstream = new AbortController()
    const fused = localDeadlineSignal(upstream.signal, 0, 'TEST_CODE')
    expect(fused.signal).toBe(upstream.signal)
    fused.dispose()
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
