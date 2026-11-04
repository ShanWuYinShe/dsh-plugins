import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createCatalogRefresh } from '../src/catalog-refresh.js'
import { WorkBuddyProbeService } from '../src/probe-service.js'
import type { WorkBuddyCredential } from '../src/auth.js'
import type { WorkBuddyModelInfo } from '../src/catalog.js'
import type { VariantRuntime } from '../src/variant-runtime.js'
import { CN_VARIANT } from '../src/variants.js'

/**
 * dispose 到达 quiescence 的回归（RULE-045/046，AC-04）：
 * - 目录刷新失败后的重试 `setTimeout` 必须在 dispose 时清掉、在途刷新链等落定；
 * - 探针服务的在途探测必须 abort，且队列落定后才从 dispose 返回。
 *
 * 判据用**未决定时器计数**与「队列 promise 已落定」，不依赖等待时长。
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const CREDENTIAL = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
} as unknown as WorkBuddyCredential

function fakeContext(): Context {
  return {
    logger: { warn: () => {}, error: () => {} },
    emit: () => {},
  } as unknown as Context
}

function fakeRuntime(fetchModels: VariantRuntime['client']['fetchModels']): VariantRuntime {
  const catalog = {
    set: () => {},
    setVisible: () => {},
    current: () => [],
    isVisible: () => false,
    excludedCount: () => 0,
    excludedModels: () => [],
  }
  return {
    variant: CN_VARIANT,
    store: {
      current: async () => CREDENTIAL,
      resolve: async () => CREDENTIAL,
      status: async () => ({ state: 'signed-in' }),
      logout: async () => {},
    },
    catalog,
    catalogStore: { saved: () => undefined, save: async () => {} },
    client: { fetchModels } as unknown as VariantRuntime['client'],
    credentialStore: {} as VariantRuntime['credentialStore'],
    filterStore: {} as VariantRuntime['filterStore'],
    shim: {} as VariantRuntime['shim'],
    catalogSource: 'fallback',
    catalogFetchedAtMs: undefined,
    catalogError: undefined,
    catalogEmpty: false,
    lastIdentity: undefined,
    publishedCatalog: '',
  } as unknown as VariantRuntime
}

describe('目录刷新链路 dispose', () => {
  it('dispose 清掉失败重试定时器，并等在与途链落定', async () => {
    vi.useFakeTimers()
    let calls = 0
    const fetchModels = async (): Promise<readonly WorkBuddyModelInfo[]> => {
      calls += 1
      throw new Error('upstream down')
    }
    const refresh = createCatalogRefresh({
      ctx: fakeContext(),
      runtimes: [],
      adapterHandles: new Map(),
      isStopped: () => false,
    })
    const runtime = fakeRuntime(fetchModels)

    refresh.refreshCatalog(runtime, 'test')
    // 冲掉拒绝链：catch 里排下 60s 重试定时器。
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount(), '失败后应有且仅有一个重试定时器').toBe(1)

    await refresh.dispose()
    expect(vi.getTimerCount(), 'dispose 后不得留下重试定时器').toBe(0)

    // 时间继续走也不再触发第二次拉取（定时器已被清掉）。
    await vi.advanceTimersByTimeAsync(180_000)
    expect(calls).toBe(1)
  })

  it('dispose 会 abort 在途刷新链（fetchModels 收到取消信号）', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchModels = (_credential: WorkBuddyCredential, signal?: AbortSignal): Promise<readonly WorkBuddyModelInfo[]> =>
      new Promise((_resolve, reject) => {
        seenSignal = signal
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    const refresh = createCatalogRefresh({
      ctx: fakeContext(),
      runtimes: [],
      adapterHandles: new Map(),
      isStopped: () => false,
    })
    const runtime = fakeRuntime(fetchModels)

    refresh.refreshCatalog(runtime, 'test')
    // 让 async 链走到 fetchModels 那一步。
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(seenSignal?.aborted).toBe(false)

    await refresh.dispose()
    expect(seenSignal?.aborted, 'dispose 必须 abort 在途上游请求').toBe(true)
  })
})

describe('探针服务 dispose', () => {
  it('abort 在途探测、等队列落定，且不再写探测记录', async () => {
    const model: WorkBuddyModelInfo = {
      id: 'm1',
      name: 'M1',
      contextWindow: 1000,
      maxTokens: 100,
      supportsImages: false,
      reasoning: { supports: true, onlyReasoning: false, canDisableThinking: true },
    }
    const set = vi.fn(async () => {})
    const send = (_effort: string | undefined, signal: AbortSignal): Promise<{ status: number; streamed: boolean }> =>
      new Promise(resolve => {
        const finish = (): void => resolve({ status: 0, streamed: false })
        if (signal.aborted) { finish(); return }
        signal.addEventListener('abort', finish, { once: true })
      })
    const service = new WorkBuddyProbeService({
      store: {
        get: () => undefined,
        record: () => ({ fp: 'f', validation: 'unknown', efforts: [], account: 'uid-1:', atMs: 0 }),
        set,
        clear: () => {},
      } as never,
      catalog: { current: () => [model] } as never,
      credentials: { current: async () => CREDENTIAL } as never,
      client: {} as never,
      account: () => 'uid-1:',
      send: () => send,
    })

    const probing = service.probe('m1')
    await service.dispose()
    const outcome = await probing
    expect(outcome.state).toBe('unavailable')
    expect(service.isRunning()).toBe(false)
    // 卸载后不再写探测记录（结果已无 owner，落盘只会污染下一个实例）。
    expect(set).not.toHaveBeenCalled()
  })
})
