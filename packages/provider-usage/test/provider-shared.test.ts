import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJson, joinRoot, num, rec, records, str, trimBase } from '../src/provider-shared.js'

/**
 * 内置 querier 共用取值助手的直接测试。
 *
 * 2026-10-08 补：8 个 provider querier 都靠这几个助手从上游 JSON 里取数——取错类型
 * （把字符串余额当数字、把对象当数组）不会报错，只会让 pill 显示错误数字或空，
 * 是典型的无自然信号退化。此前这个模块零直接测试。
 */

describe('num', () => {
  it('接受 JSON 数字与数字字符串', () => {
    expect(num(42)).toBe(42)
    expect(num(0)).toBe(0)
    expect(num(-1.5)).toBe(-1.5)
    expect(num('42')).toBe(42)
    expect(num(' 42 ')).toBe(42) // 前后空白可容忍
    expect(num('3.14')).toBe(3.14)
  })

  it('拒绝非数字与非法字符串', () => {
    for (const bad of [undefined, null, true, {}, [], Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', '12abc']) {
      expect(num(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('str', () => {
  it('接受非空字符串并去空白', () => {
    expect(str('x')).toBe('x')
    expect(str('  x  ')).toBe('x')
  })

  it('拒绝空串、纯空白与非字符串', () => {
    for (const bad of ['', '   ', undefined, null, 42, {}, []]) {
      expect(str(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })
})

describe('rec', () => {
  it('对象原样返回（同一引用，便于链式取值）', () => {
    const value = { a: 1 }
    expect(rec(value)).toBe(value)
  })

  it('非对象一律兜底成空对象（调用方可安全链式取值）', () => {
    for (const bad of [undefined, null, 42, 'x', []]) {
      const got = rec(bad)
      expect(got).toEqual({})
      expect(typeof got).toBe('object')
    }
  })
})

describe('records', () => {
  it('保留对象项、丢弃非对象项', () => {
    const list = [{ a: 1 }, 'x', 42, null, { b: 2 }, []]
    expect(records(list)).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('非数组输入返回空数组', () => {
    for (const bad of [undefined, null, {}, 'x', 42]) {
      expect(records(bad)).toEqual([])
    }
  })
})

describe('trimBase', () => {
  it('去掉尾部斜杠（一个或多个）', () => {
    expect(trimBase('https://api.example.com')).toBe('https://api.example.com')
    expect(trimBase('https://api.example.com/')).toBe('https://api.example.com')
    expect(trimBase('https://api.example.com///')).toBe('https://api.example.com')
  })

  it('路径中间的斜杠不受影响', () => {
    expect(trimBase('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
  })
})

describe('joinRoot', () => {
  it('普通拼接', () => {
    expect(joinRoot('https://api.example.com', '/v1/key')).toBe('https://api.example.com/v1/key')
  })

  it('root 已带 /v1 时不再重复追加（用户配了带 /v1 的 baseURL）', () => {
    expect(joinRoot('https://api.example.com/v1', '/v1/key')).toBe('https://api.example.com/v1/key')
    expect(joinRoot('https://api.example.com/v1/', '/v1/key')).toBe('https://api.example.com/v1/key')
  })

  it('非 /v1 开头的路径不受影响', () => {
    expect(joinRoot('https://api.example.com/v1', '/user/balance')).toBe('https://api.example.com/v1/user/balance')
  })
})

describe('getJson', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('返回解析后的 JSON 对象', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { x: 1 } }), { status: 200 })))
    expect(await getJson('https://api.example.com/x', {})).toEqual({ code: 0, data: { x: 1 } })
  })

  it('非 2xx 抛错且消息带 host 前缀（方便定位是哪家上游）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await expect(getJson('https://api.example.com/x', {})).rejects.toThrow(/api\.example\.com responded 500/)
  })

  it('2xx 但 body 不是 JSON 时抛错（不猜形状）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', { status: 200 })))
    await expect(getJson('https://api.example.com/x', {})).rejects.toThrow(/non-JSON body/)
  })

  it('把 accept 头带上，并透传调用方的额外头', async () => {
    let seen: Record<string, string> = {}
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>
      return new Response('{}', { status: 200 })
    }))
    await getJson('https://api.example.com/x', { authorization: 'Bearer x' })
    expect(seen['accept']).toBe('application/json')
    expect(seen['authorization']).toBe('Bearer x')
  })
})
