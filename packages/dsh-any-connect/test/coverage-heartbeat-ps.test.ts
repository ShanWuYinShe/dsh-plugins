import { describe, expect, it, vi } from 'vitest'

/**
 * host-heartbeat 进程起点解析（覆盖率补齐）。
 *
 * 本仓测试沙盒禁止 spawn `ps`（EPERM），真实路径跑不到成功分支；这里用
 * vi.mock 注入 execFileSync，验证「ps/PowerShell 输出 → epoch ms」的换算逻辑
 *（含 Windows file time 换算）。
 */

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

import { processStartTimeMs } from '../src/host-heartbeat.js'

describe('processStartTimeMs', () => {
  it('macOS/Linux：ps lstart 的可解析时间转 epoch ms；不可解析返回 undefined', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    execFileSyncMock.mockReturnValueOnce('Mon Nov  4 10:00:00 2026\n')
    const parsed = processStartTimeMs(4321)
    expect(typeof parsed).toBe('number')
    expect(parsed).toBe(Date.parse('Mon Nov  4 10:00:00 2026'))

    execFileSyncMock.mockReturnValueOnce('   ')
    expect(processStartTimeMs(4321)).toBeUndefined()
    execFileSyncMock.mockReturnValueOnce('not a date')
    expect(processStartTimeMs(4321)).toBeUndefined()
    platform.mockRestore()
  })

  it('ps 抛错（无此 pid / 平台无 ps）返回 undefined，不向上抛', () => {
    execFileSyncMock.mockImplementationOnce(() => { throw new Error('ps unavailable') })
    expect(processStartTimeMs(999_999_999)).toBeUndefined()
  })

  it('Windows：file time 换算为 Unix 毫秒；非法值返回 undefined', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    // 2026-11-04T02:00:00Z 的 Windows file time = (unixMs + 11644473600000) * 10000
    const unixMs = Date.parse('2026-11-04T02:00:00.000Z')
    const fileTime = (unixMs + 11_644_473_600_000) * 10_000
    execFileSyncMock.mockReturnValueOnce(`${fileTime}\n`)
    expect(processStartTimeMs(1234)).toBe(unixMs)

    execFileSyncMock.mockReturnValueOnce('0')
    expect(processStartTimeMs(1234)).toBeUndefined()
    execFileSyncMock.mockReturnValueOnce('not-a-number')
    expect(processStartTimeMs(1234)).toBeUndefined()
    execFileSyncMock.mockImplementationOnce(() => { throw new Error('powershell unavailable') })
    expect(processStartTimeMs(1234)).toBeUndefined()
    platform.mockRestore()
  })
})
