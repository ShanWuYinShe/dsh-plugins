/**
 * 会话扫描三件套的直接测试：并发限制器、消息文本抽取、带归属校验的目录删除。
 *
 * 2026-10-08 补：三者此前只经 archive-host 端到端顺带覆盖，但它们各自守着一条硬约束——
 * 并发宽度下限（0 会静默产出全 undefined）、文本只取 text 块与截断、以及**删除前两道归属
 * 校验**（宁可留下空壳目录，也不可递归多删别的会话数据）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { limitedConcurrency, messageText, removeSessionDirIfOwned } from '../src/session-scan.js'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-scan-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('limitedConcurrency', () => {
  it('跑完所有任务且结果顺序与入参一致', async () => {
    const tasks = [1, 2, 3, 4, 5].map((n) => async () => {
      await new Promise((resolve) => setTimeout(resolve, (6 - n) * 2))
      return n * 10
    })
    expect(await limitedConcurrency(2, tasks)).toEqual([10, 20, 30, 40, 50])
  })

  it('并发宽度不超过 limit', async () => {
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 6 }, () => async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return null
    })
    await limitedConcurrency(2, tasks)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('limit 为 0 或负数时仍有 1 个 worker（否则会静默返回全 undefined）', async () => {
    for (const limit of [0, -5]) {
      const ran: number[] = []
      const tasks = [1, 2, 3].map((n) => async () => {
        ran.push(n)
        return n
      })
      expect(await limitedConcurrency(limit, tasks)).toEqual([1, 2, 3])
      expect(ran).toHaveLength(3)
    }
  })

  it('limit 大于任务数、以及空任务表都不出错', async () => {
    expect(await limitedConcurrency(10, [async () => 'a'])).toEqual(['a'])
    expect(await limitedConcurrency(3, [])).toEqual([])
  })
})

describe('messageText', () => {
  it('只拼接 text 块，忽略图片与工具块', () => {
    const content = [
      { type: 'text', text: 'hello ' },
      { type: 'image', source: {} },
      { type: 'tool_use', name: 'x' },
      { type: 'text', text: 'world' },
    ]
    expect(messageText(content, 100)).toBe('hello world')
  })

  it('非数组输入返回空串', () => {
    expect(messageText('hello', 100)).toBe('')
    expect(messageText(null, 100)).toBe('')
    expect(messageText({ type: 'text', text: 'x' }, 100)).toBe('')
  })

  it('超过上限时截断并加省略号', () => {
    const text = 'x'.repeat(50)
    expect(messageText([{ type: 'text', text }], 10)).toBe('x'.repeat(10) + '…')
  })

  it('恰好等于上限时不加省略号', () => {
    const text = 'x'.repeat(10)
    expect(messageText([{ type: 'text', text }], 10)).toBe(text)
  })

  it('忽略缺 text 字段或非字符串的 text 块', () => {
    expect(messageText([{ type: 'text' }, { type: 'text', text: 42 }, { type: 'text', text: 'ok' }], 100)).toBe('ok')
  })
})

describe('removeSessionDirIfOwned', () => {
  it('目录名含 sessionId 且只装本会话文件时，连目录一起删', async () => {
    const root = tempDir()
    const sessionId = '11111111-2222-3333-4444-555555555555'
    const dir = join(root, 'sessions-' + sessionId)
    mkdirSync(dir)
    const file = join(dir, sessionId + '.jsonl')
    writeFileSync(file, '{}')
    const warn = vi.fn()
    await removeSessionDirIfOwned(sessionId, file, warn)
    expect(existsSync(dir)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('目录名不含 sessionId 时只告警、保留目录（布局变了就降级）', async () => {
    const root = tempDir()
    const sessionId = '11111111-2222-3333-4444-555555555555'
    const dir = join(root, 'hashed-dir-name')
    mkdirSync(dir)
    const file = join(dir, sessionId + '.jsonl')
    writeFileSync(file, '{}')
    const warn = vi.fn()
    await removeSessionDirIfOwned(sessionId, file, warn)
    expect(existsSync(dir)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('does not reference session')
  })

  it('目录里躺着别的会话日志时保留目录（防递归多删）', async () => {
    const root = tempDir()
    const sessionId = '11111111-2222-3333-4444-555555555555'
    const dir = join(root, 'sessions-' + sessionId)
    mkdirSync(dir)
    const file = join(dir, sessionId + '.jsonl')
    writeFileSync(file, '{}')
    writeFileSync(join(dir, 'other-session.jsonl'), '{}')
    const warn = vi.fn()
    await removeSessionDirIfOwned(sessionId, file, warn)
    expect(existsSync(dir)).toBe(true)
    expect(String(warn.mock.calls[0]?.[0])).toContain('holds other session logs')
  })

  it('本会话自己的代际文件（session.vN.jsonl / .zstd）不算他者日志', async () => {
    const root = tempDir()
    const sessionId = '11111111-2222-3333-4444-555555555555'
    const dir = join(root, 'sessions-' + sessionId)
    mkdirSync(dir)
    const file = join(dir, sessionId + '.jsonl')
    writeFileSync(file, '{}')
    writeFileSync(join(dir, 'session.v1.jsonl'), '{}')
    writeFileSync(join(dir, 'session.jsonl.zstd'), 'x')
    const warn = vi.fn()
    await removeSessionDirIfOwned(sessionId, file, warn)
    expect(existsSync(dir)).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('目录不存在、或路径退化为当前目录时是 no-op', async () => {
    const root = tempDir()
    const sessionId = 'sess-1'
    const warn = vi.fn()
    await removeSessionDirIfOwned(sessionId, join(root, 'sess-1', 'sess-1.jsonl'), warn)
    await removeSessionDirIfOwned(sessionId, 'sess-1.jsonl', warn)
    expect(warn).not.toHaveBeenCalled()
  })
})
