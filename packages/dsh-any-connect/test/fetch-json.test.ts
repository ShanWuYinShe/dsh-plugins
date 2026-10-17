import { describe, expect, it, vi } from 'vitest'
import { fetchJsonOrThrow } from '../client/fetch-json.ts'

/**
 * client 两处同形 `response.json().catch → !ok → detail → throw` 的收敛回归。
 * useVariantCard / useVariantsPage 此前各抄一份，已出现四份手抄漂移的前科。
 */

function stubResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('fetchJsonOrThrow', () => {
  it('2xx 返回解析后的 JSON', async () => {
    const fetchStub = vi.fn(async () => stubResponse(200, { status: 'signed-in' }))
    const value = await fetchJsonOrThrow(fetchStub())
    expect(value).toEqual({ status: 'signed-in' })
    expect(fetchStub).toHaveBeenCalledTimes(1)
  })

  it('非 2xx 抛 HTTP_xxx 形错误，宿主正则不命中', async () => {
    const fetchStub = vi.fn(async () => stubResponse(403, { error: 'denied' }))
    await expect(fetchJsonOrThrow(fetchStub())).rejects.toThrow('HTTP_403: denied')
  })

  it('非 2xx 且无 error 明细时只带状态码', async () => {
    const fetchStub = vi.fn(async () => stubResponse(500, {}))
    await expect(fetchJsonOrThrow(fetchStub())).rejects.toThrow(/^HTTP_500$/)
  })
})
