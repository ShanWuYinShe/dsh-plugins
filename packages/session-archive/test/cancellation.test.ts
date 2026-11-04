import { describe, expect, it } from 'vitest'
import { TYPERT as HOST_ARTIFACT } from '@chaoset/session-archive/typert'
import { readTitle, scanSession } from '../src/session-scan.js'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { makeGateway } from './gateway-fixture.js'

/**
 * SA-07 取消回归（RULE-037）：5 个 Remote 方法末尾声明 `signal: AbortSignal`
 * （typert 识别为 Gateway 注入项，不是 wire 参数），signal 透传给
 * persistence.open/read/stat 与标题索引，并在分块/批量循环处 cooperative
 * 检查。这里不重复生成器行为，只钉住三件事：生成工件声明、透传、abort 生效。
 */

/** 构造只读 persistence 桩：记录 open/read/stat 收到的 options。 */
function makePersistence(events: readonly SessionEvent[], header: SessionHeader) {
  const opened: Array<{ signal?: AbortSignal } | undefined> = []
  const reads: Array<{ signal?: AbortSignal } | undefined> = []
  const persistence = {
    open: async (_id: SessionId, _access: string, options?: { signal?: AbortSignal }) => {
      opened.push(options)
      return {
        header,
        read: async (offset = 0, length?: number, options?: { signal?: AbortSignal }) => {
          reads.push(options)
          const end = typeof length === 'number' ? offset + length : events.length
          return { eventState: 'owned', events: events.slice(offset, end) }
        },
        close: async () => {},
      }
    },
    stat: async () => undefined,
  }
  return { persistence: persistence as unknown as SessionPersistence, opened, reads }
}

describe('Remote 取消声明（SA-07）', () => {
  it('生成工件的 5 个方法都带 cancellation: { parameter: "signal" } 且 signal 不占 wire 参数', () => {
    // 取消是生成面的概念：source-mode 运行时 marker 不带它，生成的 ./typert
    // 工件里 descriptors 才有 cancellation 声明（Gateway 依此注入 signal）。
    const invocations = (HOST_ARTIFACT as unknown as { invocations: Array<{ method: string; parameters: unknown[]; cancellation?: unknown }> }).invocations
    expect(invocations.map((invocation) => invocation.method).sort()).toEqual(['count', 'delete', 'detail', 'list', 'unarchive'])
    for (const invocation of invocations) {
      expect(invocation.cancellation, invocation.method).toEqual({ parameter: 'signal' })
      // signal 不是 JSON wire 参数：list/count 的 wire 参数集合仍为空。
      if (invocation.method === 'list' || invocation.method === 'count') {
        expect(invocation.parameters).toEqual([])
      }
    }
  })

  it('Gateway 在入口即检查 signal（预取消的调用直接拒绝）', async () => {
    const { gateway } = makeGateway()
    const aborted = new AbortController()
    aborted.abort(new Error('cancelled by test'))
    await expect(gateway.list(aborted.signal)).rejects.toThrow('cancelled by test')
    await expect(gateway.count(aborted.signal)).rejects.toThrow('cancelled by test')
    await expect(gateway.detail('session-1', aborted.signal)).rejects.toThrow('cancelled by test')
    await expect(gateway.delete(['session-1'], aborted.signal)).rejects.toThrow('cancelled by test')
    await expect(gateway.unarchive(['session-1'], aborted.signal)).rejects.toThrow('cancelled by test')
  })
})

describe('signal 透传到持久化层（SA-07）', () => {
  const header = { id: 's1' as SessionId, cwd: '/proj/a', createdAt: 1 } as SessionHeader
  const events: SessionEvent[] = [
    { type: 'user/message', seq: 1, time: 1, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] } } as unknown as SessionEvent,
  ]

  it('scanSession 把同一个 signal 传给 persistence.open/read，并在 abort 后停止', async () => {
    const { persistence, opened, reads } = makePersistence(events, header)
    const controller = new AbortController()
    // 正常路径：open/read 都拿到同一个 signal。
    expect(await scanSession(persistence, header.id, () => {}, controller.signal)).toBe(header)
    expect(opened[0]?.signal).toBe(controller.signal)
    expect(reads[0]?.signal).toBe(controller.signal)

    // 预取消：open 之前/分块循环入口即抛（不会继续消费事件流）。
    const aborted = new AbortController()
    aborted.abort(new Error('aborted-before-open'))
    await expect(scanSession(persistence, header.id, () => {}, aborted.signal)).rejects.toThrow('aborted-before-open')
  })

  it('readTitle 接受并透传 signal', async () => {
    const { persistence, opened } = makePersistence(events, header)
    const controller = new AbortController()
    expect(await readTitle(persistence, header.id, controller.signal)).toBe(null)
    expect(opened[0]?.signal).toBe(controller.signal)
  })

  it('Gateway list/delete/unarchive 把 signal 传给 persistence.stat 并在预取消时拒绝', async () => {
    const stats: Array<{ signal?: AbortSignal } | undefined> = []
    const { gateway } = makeGateway({
      archived: ['s1'],
      stat: async (_id, options) => {
        stats.push(options)
        return undefined
      },
    })
    const controller = new AbortController()
    expect((await gateway.list(controller.signal)).items).toEqual([])
    expect(stats.length).toBeGreaterThan(0)
    expect(stats.every((options) => options?.signal === controller.signal)).toBe(true)

    const aborted = new AbortController()
    aborted.abort(new Error('abort-list'))
    await expect(gateway.list(aborted.signal)).rejects.toThrow('abort-list')
    await expect(gateway.delete(['s1'], aborted.signal)).rejects.toThrow('abort-list')
    await expect(gateway.unarchive(['s1'], aborted.signal)).rejects.toThrow('abort-list')
  })
})
