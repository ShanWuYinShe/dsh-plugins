/**
 * @Remote resources 声明回归（访问控制，审计 P1）。
 *
 * 官方 typert-protocol 契约：Remote 方法必须通过 resources reader 或默认
 * resolver 声明它访问的资源；dsh-api-remote-access 不检查未声明的资源，
 * 缺省即按 global 判定。delete/unarchive 的参数是数组，session 的默认
 * resolver（dsh-api-session-controller 的 resolveSessionResource）只认命名
 * 参数/对象字段的 sessionId、不解析数组参数，必须显式声明 reader；detail
 * 单参 sessionId 由默认 resolver 命中；list/count 没有具体会话参数、按
 * global 授权是刻意选择（见 src/remote.ts 文件头）。
 *
 * 断言走官方反射 API remoteMethods(gateway)（读类原型上的版本化 marker），
 * 不复制装饰器实现、也不依赖生成工件。
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { SessionArchiveGateway } from '../src/remote.js'
import type { ArchiveHost } from '../src/archive-host.js'

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

  it('list/count 不声明 resources（无会话参数，按 global 授权系有意为之）', () => {
    for (const method of ['list', 'count']) {
      expect(markerOf(method).resources).toBeUndefined()
    }
  })
})
