/**
 * @Remote resources 声明与逐项过滤回归（访问控制，审计 P1 / SA-01）。
 *
 * 官方 typert-protocol + dsh-api-remote-access 契约：
 * - 方法必须通过 resources reader 或默认 resolver 声明它访问的资源；
 *   dsh-api-remote-access 不检查未声明的资源，缺省即按 global 判定；
 * - delete/unarchive 的参数是数组，session 的默认 resolver
 *   （dsh-api-session-controller 的 resolveSessionResource）只认命名参数/对象
 *   字段的 sessionId、不解析数组参数，必须显式声明 reader；
 * - detail 单参 sessionId 由默认 resolver 命中；
 * - list/count 没有具体会话参数，入口按 global 判定，但**返回的每一行**必须
 *   逐项经 `ctx.remoteAccess.allows({kind:'session', id})` 过滤（count 用过滤后
 *   数量）——官方 session/list 的同款模型，unfiltered aggregate 是缺陷。
 *
 * 断言走官方反射 API remoteMethods(gateway)（读类原型上的版本化 marker），
 * 不复制装饰器实现、也不依赖生成工件。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { SessionArchiveGateway } from '../src/remote.js'
import type { ArchiveHost } from '../src/archive-host.js'
import type { ArchiveListRow } from '../src/types.js'

/** 构造网关实例并读出 Remote marker（只测声明，不调用 host 方法）。 */
function readMarkers() {
  const ctx = new Context()
  // host 桩：本用例只读 marker，任何方法都不会被调用。
  const gateway = new SessionArchiveGateway(ctx, { host: {} as ArchiveHost })
  return remoteMethods(gateway)
}

/** 按实现方法名取 marker。 */
function markerOf(method: string) {
  const marker = readMarkers().find((candidate) => candidate.method === method)
  if (marker === undefined) throw new Error('missing Remote marker for ' + method)
  return marker
}

function row(sessionId: string): ArchiveListRow {
  return { sessionId, title: null, cwd: null, createdAt: 0, updatedAt: 0, size: 0, live: false }
}

/**
 * 构造一个带 remoteAccess 桩的网关：allows 只放行 admitted 里的会话 id。
 * 官方远程服务是 Cordis 服务，必须挂在真实 Context 上；provide 的桩按
 * 官方 `allows(resource)` 形状判定（owner/无 Remote 调用时真实实现返回 true，
 * 这里由用例显式控制）。
 */
function gatewayWithAccess(admitted: readonly string[], config: { host: ArchiveHost }): SessionArchiveGateway {
  const ctx = new Context()
  const allows = (resource: { kind: string; id?: string }): boolean =>
    resource.kind !== 'session' || admitted.includes(String(resource.id))
  ctx.provide('remoteAccess', { allows } as never)
  return new SessionArchiveGateway(ctx, config)
}

describe('@Remote resources 声明（访问控制）', () => {
  it('五个端点齐全且 endpoint 名与实现方法名一致（不漂移）', () => {
    const markers = readMarkers()
    expect(markers.map((marker) => marker.method).sort()).toEqual(['count', 'delete', 'detail', 'list', 'unarchive'])
    // 协议约定：exportName 与实现方法同名时 marker 省略该字段。
    expect(markers.every((marker) => marker.exportName === undefined)).toBe(true)
    expect(markers.every((marker) => marker.invocation.kind === 'direct')).toBe(true)
  })

  it('delete/unarchive 声明 session reader，且把数组参数逐项交回', () => {
    for (const method of ['delete', 'unarchive']) {
      const reader = markerOf(method).resources?.session
      expect(typeof reader).toBe('function')
      // Gateway 以方法的位置参数调用 reader：batch 方法只有一个数组参数。
      expect(reader?.(['session-a', 'session-b'])).toEqual(['session-a', 'session-b'])
      // 空数组也返回数组（Gateway 判 resource-invalid 拒绝，fail-closed）。
      expect(reader?.([])).toEqual([])
    }
  })

  it('detail 不声明 reader（sessionId 单参命中默认 resolver）', () => {
    const marker = markerOf('detail')
    expect(marker.resources).toBeUndefined()
  })

  it('list/count 不声明 resources（无会话参数），逐项 allows 过滤由其方法体承担', () => {
    for (const method of ['list', 'count']) {
      expect(markerOf(method).resources).toBeUndefined()
    }
  })
})

describe('list/count 逐项 remoteAccess 过滤（SA-01）', () => {
  const allRows = [row('s1'), row('s2'), row('s3')]

  it('list 只返回 allows 放行的行（非 owner 隐藏他人会话元数据）', async () => {
    const gateway = gatewayWithAccess(['s1', 's3'], {
      host: {
        list: async () => ({ items: allRows }),
        existingIds: async () => allRows.map((item) => item.sessionId),
        count: async () => ({ count: allRows.length }),
      } as unknown as ArchiveHost,
    })
    const result = await gateway.list()
    expect(result.items.map((item) => item.sessionId)).toEqual(['s1', 's3'])
  })

  it('count 用逐项过滤后的数量（不是 host 的全量计数）', async () => {
    const gateway = gatewayWithAccess(['s2'], {
      host: {
        list: async () => ({ items: allRows }),
        existingIds: async () => allRows.map((item) => item.sessionId),
        count: async () => ({ count: allRows.length }),
      } as unknown as ArchiveHost,
    })
    expect((await gateway.count()).count).toBe(1)
  })

  it('全部被拒绝时 list 为空、count 为 0', async () => {
    const gateway = gatewayWithAccess([], {
      host: {
        list: async () => ({ items: allRows }),
        existingIds: async () => allRows.map((item) => item.sessionId),
        count: async () => ({ count: allRows.length }),
      } as unknown as ArchiveHost,
    })
    expect((await gateway.list()).items).toEqual([])
    expect((await gateway.count()).count).toBe(0)
  })

  it('owner（allows 恒 true）看到全部行', async () => {
    const gateway = gatewayWithAccess(allRows.map((item) => item.sessionId), {
      host: {
        list: async () => ({ items: allRows }),
        existingIds: async () => allRows.map((item) => item.sessionId),
        count: async () => ({ count: allRows.length }),
      } as unknown as ArchiveHost,
    })
    expect((await gateway.list()).items).toHaveLength(3)
    expect((await gateway.count()).count).toBe(3)
  })
})
