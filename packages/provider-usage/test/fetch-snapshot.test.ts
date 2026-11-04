import { describe, expect, it, vi } from 'vitest'
import { fetchSnapshot } from '../client/fetch-snapshot.ts'

/** refresh 三责（fetch / 包形解析 / 保旧值写回）中前两责的抽取回归。 */

/** 用给定 payload 的 200 响应跑一次 fetchSnapshot。 */
async function snapshotWith(payload: unknown): Promise<unknown> {
  const fetchStub = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }))
  vi.stubGlobal('fetch', fetchStub)
  try {
    return await fetchSnapshot('acme')
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('fetchSnapshot', () => {
  it('返回 snapshots[0]（快照）', async () => {
    await expect(snapshotWith({ snapshots: [{ provider: 'acme', windows: [], fetchedAt: 7 }] }))
      .resolves.toEqual({ provider: 'acme', windows: [], fetchedAt: 7 })
  })

  it('返回 snapshots[0]（未注册标记：provider 一致且 queried=false）', async () => {
    // route 层把「该 provider 无 querier」写成 {provider, queried:false}，它没有
    // windows，但仍是合法答案（pill 据此显示「未提供额度查询」）。
    await expect(snapshotWith({ snapshots: [{ provider: 'acme', queried: false }] }))
      .resolves.toEqual({ provider: 'acme', queried: false })
  })

  it('非 2xx 抛 HTTP_xxx 形错误（传输失败与「无答案」必须可区分）', async () => {
    const fetchStub = vi.fn(async () => new Response('denied', { status: 403 }))
    vi.stubGlobal('fetch', fetchStub)
    try {
      await expect(fetchSnapshot('acme')).rejects.toThrow(/^HTTP_403$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('形状不合法一律视为无答案（不抛错、不把脏数据交给渲染层）', async () => {
    // 同源 host 已做完整校验；这里只做 client 侧最小结构校验（RULE-040 纵深防御），
    // 被中间层破坏/替换的响应按「无答案」处理，由调用方保旧值/不推帧。
    const invalidPayloads: unknown[] = [
      undefined, // JSON.parse 失败
      null,
      'nope',
      {}, // 无 snapshots
      { snapshots: 'nope' }, // snapshots 非数组
      { snapshots: [] }, // 空数组 → 无首元素
      { snapshots: [null] }, // 首元素非对象
      { snapshots: ['x'] }, // 首元素非对象
      { snapshots: [{ provider: 'other', windows: [], fetchedAt: 1 }] }, // provider 与请求不一致
      { snapshots: [{ provider: 'other', queried: false }] }, // 未注册标记也不得串到别的 provider
      { snapshots: [{ provider: 'acme', windows: 'nope', fetchedAt: 1 }] }, // windows 非数组
      { snapshots: [{ provider: 'acme', windows: [], fetchedAt: 1, error: 42 }] }, // error 非字符串
    ]
    for (const payload of invalidPayloads) {
      await expect(snapshotWith(payload), `payload=${JSON.stringify(payload)}`).resolves.toBeUndefined()
    }
  })

  it('signal 透传给 fetch', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ snapshots: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    const controller = new AbortController()
    try {
      await fetchSnapshot('acme', controller.signal)
      const init = (fetchStub.mock.calls[0] as unknown[] | undefined)?.[1] as RequestInit | undefined
      expect(init).toMatchObject({ signal: controller.signal })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('force 追加 refresh=1，默认不带（自动轮询保持走宿主缓存）', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ snapshots: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    try {
      await fetchSnapshot('acme')
      let url = (fetchStub.mock.calls[0] as unknown[] | undefined)?.[0] as string
      expect(url).toBe('/plugins/provider-usage/usage?providers=acme')

      await fetchSnapshot('acme', undefined, { force: true })
      url = (fetchStub.mock.calls[1] as unknown[] | undefined)?.[0] as string
      expect(url).toBe('/plugins/provider-usage/usage?providers=acme&refresh=1')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
