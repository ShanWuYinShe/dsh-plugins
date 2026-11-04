import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.js'
import type { ProbeSender } from '../src/probe.js'
import { WorkBuddyProbeService } from '../src/probe-service.js'
import { WorkBuddyProbeStore, fingerprintModel } from '../src/probe-store.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
})

const CREDENTIAL = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: Date.now() + 3600_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop' as const,
}

function undeclaredCatalog(): WorkBuddyCatalog {
  const catalog = new WorkBuddyCatalog()
  catalog.set([{
    id: 'probe-me',
    name: 'Probe Me',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false },
  }])
  return catalog
}

function declaredCatalog(): WorkBuddyCatalog {
  const catalog = new WorkBuddyCatalog()
  catalog.set([{
    id: 'probe-me', name: 'P', contextWindow: 1, maxTokens: 1, supportsImages: false,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low'], defaultEffort: 'low', canDisableThinking: false },
  }])
  return catalog
}

interface Harness {
  service: WorkBuddyProbeService
  store: WorkBuddyProbeStore
  account: { current: string | undefined }
  calls: (string | undefined)[]
}

function harness(send: ProbeSender, account = 'uid-1:', catalog?: WorkBuddyCatalog): Harness {
  if (root === undefined) throw new Error('no root')
  const store = new WorkBuddyProbeStore({ path: join(root, '.workbuddy-probe.json'), pluginVersion: '0.0.0-test' })
  const holder = { current: account as string | undefined }
  const calls: (string | undefined)[] = []
  const service = new WorkBuddyProbeService({
    store,
    catalog: catalog ?? undeclaredCatalog(),
    credentials: { current: async () => ({ ...CREDENTIAL }) } as never,
    client: {} as never,
    account: () => holder.current,
    send: () => async (effort, signal) => {
      calls.push(effort)
      return send(effort, signal)
    },
  })
  return { service, store, account: holder, calls }
}

const ACCEPT = { status: 200, streamed: true }
const REJECT = { status: 400, streamed: false, errorCode: 'invalid_reasoning_effort' }

describe('WorkBuddyProbeService', () => {
  it('rejects unknown models and models that need no detection', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const h = harness(async () => ACCEPT)
    expect((await h.service.probe('nope')).state).toBe('unavailable')
    // Declared-set models are never probed: same harness, declared catalog.
    const h2 = harness(async () => ACCEPT, 'uid-1:', declaredCatalog())
    expect(await h2.service.probe('probe-me')).toEqual({ state: 'unavailable', reason: 'model does not need detection' })
  })

  it('prefixes unavailable reasons with the configured variant id', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const service = new WorkBuddyProbeService({
      store: new WorkBuddyProbeStore({ path: join(root, '.workbuddy-probe.json'), pluginVersion: '0.0.0-test' }),
      catalog: declaredCatalog(),
      credentials: { current: async () => ({ ...CREDENTIAL }) } as never,
      client: {} as never,
      account: () => 'uid-1:',
      variantId: 'zcode',
      send: () => async () => { throw new Error('must not send') },
    })
    // Declared-set 模型直接走 unavailable 快路径：reason 应带变体来源前缀。
    expect(await service.probe('probe-me')).toEqual({
      state: 'unavailable',
      reason: 'zcode: model does not need detection',
    })
  })

  it('runs a full validating sweep and reuses the record without new requests', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const answers: Record<string, { status: number; streamed: boolean; errorCode?: string }> = {
      low: ACCEPT, medium: REJECT,
    }
    const h = harness(async effort => effort === undefined ? ACCEPT : (answers[effort!] ?? REJECT))
    const first = await h.service.probe('probe-me')
    expect(first.state).toBe('ok')
    if (first.state === 'ok') {
      expect(first.validation).toBe('validating')
      expect(first.efforts).toEqual(['low'])
    }
    const sent = h.calls.length
    expect(sent).toBeGreaterThan(0)
    // A fresh service over the same store file sees the stored observation:
    // zero new requests.
    const reread = new WorkBuddyProbeService({
      store: h.store, catalog: undeclaredCatalog(),
      credentials: { current: async () => ({ ...CREDENTIAL }) } as never,
      client: {} as never, account: () => 'uid-1:',
      send: () => async () => { throw new Error('must not send') },
    })
    const second = await reread.probe('probe-me')
    expect(second).toEqual({ state: 'ok', validation: 'validating', efforts: ['low'], requests: 0 })
  })

  it('drops an observation when the account changes mid-flight', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const holder = { current: 'uid-1:' as string | undefined }
    const store = new WorkBuddyProbeStore({ path: join(root, '.workbuddy-probe.json'), pluginVersion: '0.0.0-test' })
    const service = new WorkBuddyProbeService({
      store,
      catalog: undeclaredCatalog(),
      credentials: { current: async () => ({ ...CREDENTIAL }) } as never,
      client: {} as never,
      account: () => holder.current,
      send: () => async effort => {
        // Flip on the first non-baseline attempt (the sentinel): the sweep
        // then runs to completion under the new account and must be dropped.
        if (effort !== undefined) holder.current = 'uid-2:'
        return ACCEPT
      },
    })
    const result = await service.probe('probe-me')
    expect(result).toEqual({ state: 'unavailable', reason: 'account changed during detection' })
    // Nothing stored under either account.
    expect(store.get('probe-me', 'x', 'uid-1:')).toBeUndefined()
    expect(store.get('probe-me', 'x', 'uid-2:')).toBeUndefined()
  })

  it('auto-detects missing candidates', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    // 候选（未声明档位且无有效记录）自动入队并落盘。
    const h = harness(async effort => effort === undefined ? ACCEPT : (effort === 'low' ? ACCEPT : REJECT))
    h.service.probeMissingCandidates()
    // isRunning 在队列入队前为 false，不能当"已开始"的信号：先等请求真的发出
    // （此时探针必然已在运行），再等它退出。running 从进入探针前一直保持到
    // store.set 落盘完成之后（见 probe-service.ts 的 try/finally），所以它变回
    // false ⇔ 本轮清扫的异步写已全部结束——afterEach 删目录因此不可能再与在途
    // 写竞态（旧写法只等内存记录，磁盘写还在飞，曾报 ENOTEMPTY）。
    await vi.waitFor(() => expect(h.calls.length).toBeGreaterThan(0), { timeout: 5000 })
    await vi.waitFor(() => expect(h.service.isRunning()).toBe(false), { timeout: 5000 })
    // 记录已在内存里且已落盘。
    expect(h.store.get('probe-me', fingerprintModel(undeclaredCatalog().current()[0]!), 'uid-1:')?.validation).toBe('validating')
  })
  it('reports sweep probe failures through onSweepError instead of unhandled rejection', async () => {
    // 回归:清扫入口丢弃 promise,而 credentials.current() 会因凭据区域
    // 不匹配抛 RegionMismatchError——rejection 无人接在 Node ≥15 默认
    // 策略下可终止宿主进程。失败必须经 onSweepError 上报。
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const store = new WorkBuddyProbeStore({ path: join(root, '.workbuddy-probe.json'), pluginVersion: '0.0.0-test' })
    const sweepErrors: Array<{ modelId: string; message: string }> = []
    const service = new WorkBuddyProbeService({
      store,
      catalog: undeclaredCatalog(),
      credentials: { current: async () => { throw new Error('received a WorkBuddy AI credential in its desktop file') } } as never,
      client: {} as never,
      account: () => 'uid-1:',
      onSweepError: (modelId, error) => {
        sweepErrors.push({ modelId, message: error instanceof Error ? error.message : String(error) })
      },
    })
    service.probeMissingCandidates()
    await vi.waitFor(() => {
      expect(sweepErrors.some(e => e.modelId === 'probe-me' && e.message.includes('credential'))).toBe(true)
    }, { timeout: 5000 })
  })

  it('skips candidates that already have a usable observation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const h = harness(async effort => effort === undefined ? ACCEPT : (effort === 'low' ? ACCEPT : REJECT))
    const first = await h.service.probe('probe-me')
    expect(first.state).toBe('ok')
    const sent = h.calls.length
    expect(sent).toBeGreaterThan(0)
    // 再次自动检测：记录仍有效（同指纹、同账号、未过期），零新请求。
    // 断言"不会入队"而不是"等 150ms 没看到请求"：probeMissingCandidates 的候选
    // 筛选是同步的，入队是发请求的必要前置，未入队即结构上零新请求——不依赖
    // 观察窗口长短（旧写法在慢机器上会漏报、在快机器上白等）。
    const enqueue = vi.spyOn(h.service, 'probe')
    h.service.probeMissingCandidates()
    expect(enqueue).not.toHaveBeenCalled()
    expect(h.calls.length).toBe(sent)
  })
})
