import { describe, expect, it, vi } from 'vitest'
import { fetchSnapshot } from '../client/fetch-snapshot.ts'

/** refresh 三责（fetch / 包形解析 / 保旧值写回）中前两责的抽取回归。 */

describe('fetchSnapshot', () => {
  it('返回 snapshots[0]（快照或未注册标记）', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      snapshots: [{ provider: 'acme', windows: [], fetchedAt: 7 }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    try {
      const snapshot = await fetchSnapshot('acme')
      expect(snapshot).toEqual({ provider: 'acme', windows: [], fetchedAt: 7 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('非 2xx 抛 HTTP_xxx 形错误', async () => {
    const fetchStub = vi.fn(async () => new Response('denied', { status: 403 }))
    vi.stubGlobal('fetch', fetchStub)
    try {
      await expect(fetchSnapshot('acme')).rejects.toThrow(/^HTTP_403$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('形状不对的 200 按失败处理（渲染层要读 status.status）', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ snapshots: [null] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchStub)
    try {
      await expect(fetchSnapshot('acme')).rejects.toThrow('unexpected usage payload')
    } finally {
      vi.unstubAllGlobals()
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
})
