/** resource-provider:地址解析、live 流的帧纪律(首帧/值变/错误折叠/abort)与协议注册。 */

import { describe, expect, it, vi } from 'vitest'

type FetchSnapshot = (provider: string, signal?: AbortSignal, options?: { force?: boolean }) => Promise<SnapshotAnswer | undefined>

const fetchMock = vi.hoisted(() =>
  vi.fn<FetchSnapshot>(() => Promise.resolve(undefined)),
)
vi.mock('../client/fetch-snapshot.js', () => ({ fetchSnapshot: fetchMock }))

import { type SnapshotAnswer } from '../client/fetch-snapshot.js'
import type { UsageSnapshot } from '../src/types.js'
import { RESOURCE_POLL_INTERVAL_MS, RESOURCE_POLL_MARGIN_MS, RESOURCE_POLL_STEP_MS, providerOfAddress, registerProviderUsageResources, usageResourceAddress, usageStream } from '../client/resource-provider.js'
function answer(overrides: Partial<UsageSnapshot> = {}): SnapshotAnswer {
  return { provider: 'acme', windows: [{ id: 'w', label: 'W', remain: 3, unit: 'credits' }], fetchedAt: 1, ...overrides }
}

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

  it('同一条失败不因 fetchedAt 变化重复推帧（失败帧比较键不含本地墙钟）', async () => {
    // 回归:失败帧的 fetchedAt 是本地 Date.now(),每次轮询必然不同;此前它参与
    // 「序列化结果有变化才推帧」的比较,于是每 60s 都推一帧内容恒定变化的失败帧
    // (视觉不变却唤醒所有订阅者)。失败帧只按业务内容(provider/windows/error)比较。
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      fetchMock.mockReset()
      fetchMock
        .mockRejectedValueOnce(new Error('HTTP_502'))
        .mockRejectedValueOnce(new Error('HTTP_502'))
        .mockResolvedValueOnce(answer({ fetchedAt: 5 }))
      const controller = new AbortController()
      const stream = usageStream(usageResourceAddress('acme'), controller.signal, 5)[Symbol.asyncIterator]()

      // 首帧:第一次取数失败 → 失败帧(fetchedAt=1000)。
      const first = await stream.next()
      expect(first.done).toBe(false)
      expect(first.value).toEqual({ ok: true, value: { provider: 'acme', windows: [], fetchedAt: 1_000, error: 'HTTP_502' } })

      // 第二次取数同样失败、但本地墙钟已经推进(fetchedAt=2000):不得再推帧。
      // 只有第三次取数成功才推第二帧——若主比较键又把 fetchedAt 算进去,
      // 第二次轮询就会提前被当成「变化」而推帧,这里立刻红。
      vi.setSystemTime(2_000)
      const second = stream.next()
      await vi.advanceTimersByTimeAsync(5)
      await vi.advanceTimersByTimeAsync(5)
      const secondFrame = await second
      expect(secondFrame.done).toBe(false)
      expect(secondFrame.value).toEqual({ ok: true, value: answer({ fetchedAt: 5 }) })

      // 收够即断流(生产 60s 循环只在测试外发生)。
      controller.abort()
      const end = await stream.next()
      expect(end.done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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

describe('地址解析', () => {
  it('providerOfAddress 只认本协议且拒绝空 path', () => {
    expect(providerOfAddress(usageResourceAddress('acme'))).toBe('acme')
    expect(providerOfAddress(usageResourceAddress('a b'))).toBe('a b')
    expect(providerOfAddress('dsh-resource://other/acme')).toBeUndefined()
    expect(providerOfAddress('dsh-resource://provider-usage/')).toBeUndefined()
    expect(providerOfAddress('https://provider-usage/acme')).toBeUndefined()
    expect(providerOfAddress('not a url')).toBeUndefined()
  })
})

describe('registerProviderUsageResources', () => {
  it('把协议 provider 注册成 ctx.effect，并暴露 open 的 live 流', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(answer())
    let registered: { protocol: string; open: (address: string, ctx: { signal: AbortSignal }) => AsyncIterable<unknown> } | undefined
    const dispose = vi.fn()
    const effects: Array<{ body: () => () => void; label: string | undefined }> = []
    const ctx = {
      effect: (body: () => () => void, label?: string) => {
        effects.push({ body, label })
        return () => {}
      },
      resources: { register: (p: never) => { registered = p as never; return dispose } },
    }
    registerProviderUsageResources(ctx as never)
    // 注册必须作为 effect 交付：插件 fiber 卸载/HMR 时由 Cordis 反注册。
    expect(effects).toHaveLength(1)
    expect(effects[0]!.label).toContain('provider-usage')
    const disposer = effects[0]!.body()
    expect(registered!.protocol).toBe('provider-usage')
    expect(disposer).toBe(dispose)
    const openController = new AbortController()
    const frames = await firstFrames(registered!.open(usageResourceAddress('acme'), { signal: openController.signal }), 1, openController)
    expect(frames).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledWith('acme', expect.any(AbortSignal))
  })
})

// 定时节奏常量与 useResource 流同源。
describe('RESOURCE_POLL_*', () => {
  it('节拍保持 60s(与宿主 registry 缓存同量级)', () => {
    expect(RESOURCE_POLL_INTERVAL_MS).toBe(60_000)
  })

  it('步长 = 节拍 + 相位余量：下一次读取落在宿主缓存过期之后', () => {
    // 宿主成功缓存默认 TTL 与节拍同为 60s；不加余量时某一帧可能命中未过期
    // 缓存，实际更新间隔被拉长到 ~120s。
    expect(RESOURCE_POLL_MARGIN_MS).toBe(5_000)
    expect(RESOURCE_POLL_STEP_MS).toBe(RESOURCE_POLL_INTERVAL_MS + RESOURCE_POLL_MARGIN_MS)
  })
})
