/**
 * @Remote resources 声明与逐项过滤/业务编排回归（访问控制，审计 P1 / SA-01 / SA-08）。
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
 * SA-08 后五个能力方法体都在 Gateway 上（含入口闸门与结果归类），本文件
 * 同时验证这些方法体行为。
 *
 * 断言走官方反射 API remoteMethods(gateway)（读类原型上的版本化 marker），
 * 不复制装饰器实现、也不依赖生成工件。
 */

import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { makeGateway } from './gateway-fixture.js'

/** 构造网关实例并读出 Remote marker（只测声明，不调用方法）。 */
function readMarkers() {
  return remoteMethods(makeGateway().gateway)
}

/** 按实现方法名取 marker。 */
function markerOf(method: string) {
  const marker = readMarkers().find((candidate) => candidate.method === method)
  if (marker === undefined) throw new Error('missing Remote marker for ' + method)
  return marker
}

const liveSignal = (): AbortSignal => new AbortController().signal

function snapshotOf(id: string) {
  return { header: { id, createdAt: 1 } }
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
    expect(markerOf('detail').resources).toBeUndefined()
  })

  it('list/count 不声明 resources（无会话参数），逐项 allows 过滤由其方法体承担', () => {
    for (const method of ['list', 'count']) {
      expect(markerOf(method).resources).toBeUndefined()
    }
  })
})

describe('list/count 逐项 remoteAccess 过滤（SA-01 / SA-08 方法体）', () => {
  const ids = ['s1', 's2', 's3']
  const fixtures = (allows?: (id: string) => boolean) => makeGateway({
    archived: ids,
    snapshots: Object.fromEntries(ids.map((id) => [id, snapshotOf(id)])),
    // 每行一个 title 事件：rowFor 标题直读路径覆盖（无 sessionQuery）。
    events: Object.fromEntries(ids.map((id) => [id, [
      { type: 'session/title', seq: 0, time: 1, data: { title: 'T-' + id, messageSeqs: [], source: { kind: 'user' } } },
    ]])),
    allows,
  })

  it('list 只返回 allows 放行的行（非 owner 隐藏他人会话元数据）', async () => {
    const { gateway } = fixtures((id) => id === 's1' || id === 's3')
    const result = await gateway.list(liveSignal())
    expect(result.items.map((item) => item.sessionId)).toEqual(['s1', 's3'])
    expect(result.items.map((item) => item.title)).toEqual(['T-s1', 'T-s3'])
  })

  it('count 用逐项过滤后的数量（不是全量计数）', async () => {
    const { gateway } = fixtures((id) => id === 's2')
    expect((await gateway.count(liveSignal())).count).toBe(1)
  })

  it('全部被拒绝时 list 为空、count 为 0', async () => {
    const { gateway } = fixtures(() => false)
    expect((await gateway.list(liveSignal())).items).toEqual([])
    expect((await gateway.count(liveSignal())).count).toBe(0)
  })

  it('owner（allows 恒 true）看到全部行', async () => {
    const { gateway } = fixtures()
    expect((await gateway.list(liveSignal())).items).toHaveLength(3)
    expect((await gateway.count(liveSignal())).count).toBe(3)
  })

  it('空归档集合：list 空、count 0（不触发持久化枚举）', async () => {
    const { gateway, statCalls } = makeGateway()
    expect((await gateway.list(liveSignal())).items).toEqual([])
    expect((await gateway.count(liveSignal())).count).toBe(0)
    expect(statCalls).toEqual([])
  })
})

describe('Gateway 能力方法体（SA-08）', () => {
  it('detail 在方法体内做归档成员闸门：非成员抛 session-archive/not-archived', async () => {
    const { gateway } = makeGateway({
      archived: ['s1'],
      snapshots: { s1: snapshotOf('s1') },
      events: { s1: [] },
    })
    await expect(gateway.detail('other', liveSignal())).rejects.toMatchObject({ code: 'session-archive/not-archived' })
    const detail = await gateway.detail('s1', liveSignal())
    expect(detail.sessionId).toBe('s1')
    expect(detail.messages).toEqual([])
  })

  it('delete 在方法体内分流归档成员：非成员归入 not-archived，成员走定位/删除流程', async () => {
    const { gateway } = makeGateway({
      archived: ['s1'],
      snapshots: { s1: snapshotOf('s1') }, // 无 location → 文件不可定位
    })
    const result = await gateway.delete(['s1', 'foreign'], liveSignal())
    expect(result.deleted).toEqual([])
    expect(result.failed).toEqual([
      { sessionId: 'foreign', reason: 'not-archived' },
      { sessionId: 's1', reason: 'unlocatable' },
    ])
    expect(result.removedFromArchive).toBe(0)
  })

  it('unarchive 与 delete 对称：非成员归入 not-archived，成员 confirm 复核后归类', async () => {
    const { gateway, removed } = makeGateway({
      archived: ['s1'],
      snapshots: { s1: snapshotOf('s1') },
    })
    const result = await gateway.unarchive(['s1', 'foreign'], liveSignal())
    expect(result.restored).toEqual([])
    expect(result.failed).toEqual([
      { sessionId: 'foreign', reason: 'not-archived' },
      { sessionId: 's1', reason: 'not-restorable' },
    ])
    expect(removed).toEqual([])
  })

  it('delete：快照后文件已消失（absent）按幂等删除处理，且内存会话仍在时返回 needsRestart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-gw-absent-'))
    try {
      const missing = path.join(dir, 'session.jsonl')
      const { gateway } = makeGateway({
        archived: ['s1'],
        snapshots: { s1: { header: { id: 's1', createdAt: 1 }, location: { kind: 'jsonl', path: missing } } },
        // busyIfLive 第一次读为 undefined（不拒绝）→ markDeleted 复核时返回会话
        // （文件已删、内存仍在 → needsRestart）。
        sessionGets: [undefined, { id: 's1' }],
      })
      const result = await gateway.delete(['s1'], liveSignal())
      expect(result).toEqual({ deleted: ['s1'], failed: [], removedFromArchive: 0, needsRestart: ['s1'] })
      expect(fs.existsSync(missing)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('delete：内存中的会话按显式状态拒绝（busy），文件保持原状', async () => {
    // 真实文件 + location：fileInfo 定位成功后才进入锁内的显式状态判定。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-gw-busy-'))
    const file = path.join(dir, 's1', 'session.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '[]')
    try {
      const { gateway } = makeGateway({
        archived: ['s1'],
        snapshots: { s1: { header: { id: 's1', createdAt: 1 }, location: { kind: 'jsonl', path: file } } },
        inMemory: ['s1'],
      })
      const result = await gateway.delete(['s1'], liveSignal())
      expect(result).toEqual({ deleted: [], failed: [{ sessionId: 's1', reason: 'busy' }], removedFromArchive: 0, needsRestart: [] })
      expect(fs.existsSync(file)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
