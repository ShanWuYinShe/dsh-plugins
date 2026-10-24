/** resource-provider:地址解析、live 流的帧纪律(首帧/值变/错误折叠/abort)与可选注册。 */

import { describe, expect, it, vi } from 'vitest'

type FetchSnapshot = (provider: string, signal?: AbortSignal, options?: { force?: boolean }) => Promise<SnapshotAnswer | undefined>

const fetchMock = vi.hoisted(() =>
  vi.fn<FetchSnapshot>(() => Promise.resolve(undefined)),
)
vi.mock('../client/fetch-snapshot.js', () => ({ fetchSnapshot: fetchMock }))

import { type SnapshotAnswer } from '../client/fetch-snapshot.js'
import type { UsageSnapshot } from '../src/types.js'
import { RESOURCE_POLL_INTERVAL_MS, providerOfAddress, registerProviderUsageResources, usageResourceAddress, usageStream } from '../client/resource-provider.js'
function answer(overrides: Partial<UsageSnapshot> = {}): SnapshotAnswer {
  return { provider: 'acme', windows: [{ id: 'w', label: 'W', remain: 3, unit: 'credits' }], fetchedAt: 1, ...overrides }
}

/** 收集流前 n 帧(或流自然结束);测试永远不等真 60s 定时。 */
/** 收集流前 n 帧;收够即 abort(先断流再退出,否则 for-await 挂在 60s sleep 上)。 */
async function firstFrames(stream: AsyncIterable<unknown>, count: number, controller: AbortController): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of stream) {
    frames.push(frame)
    if (frames.length >= count) {
      controller.abort()
      break
    }
  }
  return frames
}

describe('usageStream', () => {
  it('首帧立即给出,值不变不重复推帧,值变才推', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(answer({ fetchedAt: 1 })).mockResolvedValueOnce(answer({ fetchedAt: 1 })).mockResolvedValueOnce(answer({ fetchedAt: 2, windows: [{ id: 'w', label: 'W', remain: 5, unit: 'credits' }] }))
    const controller = new AbortController()
    const frames = await firstFrames(usageStream(usageResourceAddress('acme'), controller.signal, 5), 2, controller)
    expect(frames).toEqual([
      { ok: true, value: answer({ fetchedAt: 1 }) },
      { ok: true, value: answer({ fetchedAt: 2, windows: [{ id: 'w', label: 'W', remain: 5, unit: 'credits' }] }) },
    ])
  })

  it('取数错误折叠成带 error 字段的快照帧,而非抛出', async () => {
    fetchMock.mockReset()
    fetchMock.mockRejectedValueOnce(new Error('HTTP_502'))
    const controller = new AbortController()
    const frames = await firstFrames(usageStream(usageResourceAddress('acme'), controller.signal, 5), 1, controller)
    expect(frames).toEqual([{ ok: true, value: { provider: 'acme', windows: [], fetchedAt: expect.any(Number), error: 'HTTP_502' } }])
  })

  it('abort 后流结束(生产 60s 循环只在测试外发生)', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(answer())
    const controller = new AbortController()
    const stream = usageStream(usageResourceAddress('acme'), controller.signal, 5)[Symbol.asyncIterator]()
    const first = await stream.next()
    expect(first.done).toBe(false)
    controller.abort()
    const second = await stream.next()
    expect(second.done).toBe(true)
  })
})

describe('registerProviderUsageResources', () => {
  it('resources 缺席时是 no-op 反注册器', () => {
    const ctx = { get: () => undefined }
    expect(registerProviderUsageResources(ctx as never)).toBeInstanceOf(Function)
    expect(() => registerProviderUsageResources(ctx as never)()).not.toThrow()
  })

  it('get 抛错(无 get 语义的上下文)同样安全跳过', () => {
    expect(() => registerProviderUsageResources({ get: () => { throw new Error('no inject') } } as never)).not.toThrow()
  })

  it('注册的 provider 帧是地址协议的流;反注册器来自 resources.register', async () => {
    fetchMock.mockResolvedValue(answer())
    let registered: { protocol: string; open: (address: string, ctx: { signal: AbortSignal }) => AsyncIterable<unknown> } | undefined
    const dispose = vi.fn()
    const ctx = { get: () => ({ register: (p: never) => { registered = p as never; return dispose } }) }
    const result = registerProviderUsageResources(ctx as never)
    expect(registered!.protocol).toBe('provider-usage')
    const openController = new AbortController()
    const frames = await firstFrames(registered!.open(usageResourceAddress('acme'), { signal: openController.signal }), 1, openController)
    expect(frames).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('acme', expect.any(AbortSignal))
    result()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

// 定时节奏常量与 hook 轮询同源:改这里就同步改了抑制窗的宽度基准。
describe('RESOURCE_POLL_INTERVAL_MS', () => {
  it('保持 60s(与宿主 registry 缓存同量级)', () => {
    expect(RESOURCE_POLL_INTERVAL_MS).toBe(60_000)
  })
})
