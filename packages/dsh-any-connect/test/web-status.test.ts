import { describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.js'
import type { WorkBuddyCredentialStore } from '../src/auth.js'
import type { WorkBuddyModelInfo } from '../src/catalog.js'
import { workBuddyWebStatus } from '../src/web-status.js'
import type { WorkBuddyStatusRouteOptions, WorkBuddyWebStatus } from '../src/web-status.js'

/** Signed-in 成员：测试以已登录 store 构造，联合的 signed-out 分支没有模型/账单字段。 */
type WorkBuddySignedInStatus = Extract<WorkBuddyWebStatus, { status: 'signed-in' }>

/**
 * Offline unit tests for the status document the plugin card renders: the
 * unified per-model rows (one row per served model carrying window, billing
 * facts, and declared efforts) and the rate suppression for models whose
 * 免费 chip already says it all.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 1234,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

function storeWith(credential: WorkBuddyCredential | undefined): WorkBuddyCredentialStore {
  return {
    status: async () => credential === undefined
      ? { state: 'signed-out' }
      : { state: 'signed-in', expiresAtMs: credential.expiresAtMs, nickname: 'tester', source: credential.source },
    current: async () => credential,
  } as unknown as WorkBuddyCredentialStore
}

function clientWith(result: Promise<unknown>): WorkBuddyStatusRouteOptions["fetchCredits"] {
  return (async () => result) as WorkBuddyStatusRouteOptions["fetchCredits"]
}

function model(overrides: Partial<WorkBuddyModelInfo>): WorkBuddyModelInfo {
  return {
    id: 'm',
    name: 'M',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    billing: { free: false },
    ...overrides,
  } as WorkBuddyModelInfo
}

describe('workBuddyWebStatus', () => {
  it('returns a bare signed-out document without touching credits', async () => {
    const fetchCredits = vi.fn()
    const status = await workBuddyWebStatus({
      store: storeWith(undefined),
      fetchCredits: fetchCredits as unknown as NonNullable<WorkBuddyStatusRouteOptions['fetchCredits']>,
      models: () => [],
      catalog: () => ({ source: 'fallback' }),
      probe: () => ({ running: false, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    })
    expect(status).toEqual({ status: 'signed-out' })
    expect(fetchCredits).not.toHaveBeenCalled()
  })

  it('keeps the multiplier on a promo model and suppresses it on a free one', async () => {
    const status = (await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      fetchCredits: clientWith(Promise.resolve({ total: 43, accounts: [] })),
      models: () => [
        model({ id: 'promo', name: 'Promo', contextWindow: 200000, billing: { credits: 'x0.79 credits', badges: ['夜间折扣'], free: false } }),
        model({ id: 'free', name: 'Free', contextWindow: 192000, billing: { credits: 'x0.00', badges: ['限时免费'], free: true } }),
      ],
      catalog: () => ({ source: 'live', fetchedAt: 1700000000000 }),
      probe: () => ({ running: false, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    }) as WorkBuddySignedInStatus)
    expect(status.status).toBe('signed-in')
    // 统一行：每个被服务的模型一行，窗口字段恒在；免费行的倍率被抑制
    //（免费 chip 已说明一切），促销行保留归一化后的倍率。
    expect(status.models).toEqual([
      { id: 'promo', name: 'Promo', contextWindow: 200000, largerWindows: [], badges: ['夜间折扣'], credits: 'x0.79' },
      { id: 'free', name: 'Free', contextWindow: 192000, largerWindows: [], badges: ['限时免费'], free: true },
    ])
  })

  it('serves a row for every model, not only the promo ones', async () => {
    const status = (await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      fetchCredits: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [model({ id: 'plain', name: 'Plain', contextWindow: 256000, billing: { credits: 'x1.62', free: false } })],
      catalog: () => ({ source: 'saved', fetchedAt: 1700000000000 }),
      probe: () => ({ running: false, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    }) as WorkBuddySignedInStatus)
    // 统一模型列表是全量行：普通倍率模型同样有一行（倍率裸显）。
    expect(status.models).toEqual([
      { id: 'plain', name: 'Plain', contextWindow: 256000, largerWindows: [], credits: 'x1.62' },
    ])
    expect(status.credits).toEqual({ total: 1, accounts: [] })
  })

  it('carries the catalog source, fetch time, and last error through', async () => {
    const live = (await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      fetchCredits: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [],
      catalog: () => ({ source: 'live', fetchedAt: 1700000000000 }),
      probe: () => ({ running: true, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    }) as WorkBuddySignedInStatus)
    expect(live.catalog).toEqual({ source: 'live', fetchedAt: 1700000000000 })
    expect(live.probe).toEqual({ running: true, results: [] })
    expect(live.probeKey).toBe('test-key')
    const failed = (await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      fetchCredits: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [],
      catalog: () => ({ source: 'saved', fetchedAt: 1699999999999, error: 'upstream down' }),
      probe: () => ({ running: false, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    }) as WorkBuddySignedInStatus)
    expect(failed.catalog).toEqual({ source: 'saved', fetchedAt: 1699999999999, error: 'upstream down' })
  })

  it('degrades a credits failure to creditsError and keeps the model facts', async () => {
    const status = (await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      fetchCredits: clientWith(Promise.reject(new Error('boom'))),
      models: () => [model({ id: 'free', name: 'Free', contextWindow: 192000, billing: { credits: 'x0.00', free: true } })],
      catalog: () => ({ source: 'fallback', error: 'boom' }),
      probe: () => ({ running: false, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    }) as WorkBuddySignedInStatus)
    expect(status.creditsError).toBe('boom')
    expect(status.models).toEqual([
      { id: 'free', name: 'Free', contextWindow: 192000, largerWindows: [], free: true },
    ])
  })

  it('carries declared effort levels and larger windows on the unified rows', async () => {
    const status = (await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      fetchCredits: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [
        model({ id: 'plain', name: 'Plain', contextWindow: 200000 }),
        {
          ...model({
            id: 'tiered',
            name: 'Tiered',
            contextWindow: 300000,
            reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', canDisableThinking: true },
          }),
          supportedContextWindows: [300000, 1000000],
          maxInputTokens: 1000000,
        },
      ],
      catalog: () => ({ source: 'live' }),
      probe: () => ({ running: false, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    }) as WorkBuddySignedInStatus)
    expect(status.models).toEqual([
      { id: 'plain', name: 'Plain', contextWindow: 200000, largerWindows: [] },
      {
        id: 'tiered',
        name: 'Tiered',
        contextWindow: 300000,
        largerWindows: [1000000],
        efforts: ['low', 'high', 'max'],
      },
    ])
  })
})

describe('workBuddyWebStatus context', () => {
  it('lists working budgets and larger options for every served model', async () => {
    const status = (await workBuddyWebStatus({
      store: storeWith(CREDENTIAL),
      fetchCredits: clientWith(Promise.resolve({ total: 1, accounts: [] })),
      models: () => [
        model({ id: 'plain', name: 'Plain', contextWindow: 200000 }),
        {
          ...model({ id: 'tiered', name: 'Tiered', contextWindow: 300000 }),
          supportedContextWindows: [300000, 1000000],
          maxInputTokens: 1000000,
        },
      ],
      catalog: () => ({ source: 'live' }),
      probe: () => ({ running: false, results: [] }),
      probeKey: 'test-key',
      // 路由注册的必填项；本文件只测状态文档组装，不挂路由。
      path: '/workbuddy-status-test',
    }) as WorkBuddySignedInStatus)
    // 旧 context 区块已并入统一行：窗口与可选更大窗口随每行携带。
    expect(status.models).toEqual([
      { id: 'plain', name: 'Plain', contextWindow: 200000, largerWindows: [] },
      { id: 'tiered', name: 'Tiered', contextWindow: 300000, largerWindows: [1000000] },
    ])
  })
})
