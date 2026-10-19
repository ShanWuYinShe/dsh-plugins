/** Registry behaviour: registration, caching, failure posture, and redaction. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ProviderUsageRegistry, safeMessage } from '../src/registry.js'
import { BUILTIN_USAGE_QUERIERS } from '../src/providers.js'
import type { UsageSnapshot } from '../src/types.js'

/** Build a registry with a pinned clock so no test ever sleeps. */
function makeRegistry(options: { ttlMs?: number; errorTtlMs?: number; unresolvedTtlMs?: number; timeoutMs?: number } = {}) {
  const ctx = new Context()
  let now = 1_000
  const registry = new ProviderUsageRegistry(ctx, {
    cacheTtlMs: options.ttlMs ?? 60_000,
    errorCacheTtlMs: options.errorTtlMs ?? 10_000,
    unresolvedTtlMs: options.unresolvedTtlMs ?? 60_000,
    queryTimeoutMs: options.timeoutMs ?? 15_000,
    now: () => now,
  })
  return { registry, advance: (ms: number) => { now += ms } }
}

/** 按 index.ts 的 apply 口径把内置注册表装进注册表；给了 keys 就只装其中一部分。 */
function makeBuiltinRegistry(keys?: readonly string[]): ProviderUsageRegistry {
  const { registry } = makeRegistry()
  for (const [provider, entry] of BUILTIN_USAGE_QUERIERS) {
    if (keys !== undefined && !keys.includes(provider)) continue
    registry.register(provider, entry.querier, entry.displayName)
  }
  return registry
}

/** 本次改动前的内置注册表原貌：9 条键，没有两条官方 DeepSeek 路由。 */
const PRE_FIX_BUILTIN_KEYS: readonly string[] = [
  'deepseek',
  'openrouter',
  'moonshot',
  'siliconflow',
  'bigmodel',
  'minimax',
  'openai',
  'opencode',
  'opencode-go',
]

/** A querier answering a fixed snapshot. */
function fixedQuerier(windows: { id: string; label: string; remain?: number; unit: string }[], plan?: string) {
  return vi.fn(async (): Promise<UsageSnapshot> => ({
    provider: 'acme',
    ...plan === undefined ? {} : { plan },
    windows,
    fetchedAt: 0,
  }))
}

describe('ProviderUsageRegistry', () => {
  it('answers undefined for a provider with no querier', async () => {
    const { registry } = makeRegistry()
    expect(await registry.snapshot('nobody')).toBeUndefined()
    expect(registry.has('nobody')).toBe(false)
    expect(registry.providers()).toEqual([])
  })

  it('reports registered providers and answers their snapshots', async () => {
    const { registry } = makeRegistry()
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 5, unit: 'credits' }])
    registry.register('acme', querier, 'Acme')

    expect(registry.providers()).toEqual(['acme'])
    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.provider).toBe('acme')
    expect(snapshot?.displayName).toBe('Acme')
    expect(snapshot?.windows).toEqual([{ id: 'a', label: 'A', remain: 5, unit: 'credits' }])
  })

  it('serves a fresh answer from cache and refetches once it expires', async () => {
    const { registry, advance } = makeRegistry({ ttlMs: 100 })
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 5, unit: 'credits' }])
    registry.register('acme', querier)

    await registry.snapshot('acme')
    await registry.snapshot('acme')
    expect(querier).toHaveBeenCalledTimes(1)

    advance(101)
    await registry.snapshot('acme')
    expect(querier).toHaveBeenCalledTimes(2)
  })

  it('force 绕过缓存重新查询，新答案回写后普通读恢复走缓存', async () => {
    const { registry } = makeRegistry({ ttlMs: 60_000 })
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 5, unit: 'credits' }])
    registry.register('acme', querier)

    await registry.snapshot('acme')
    await registry.snapshot('acme')
    expect(querier).toHaveBeenCalledTimes(1)

    // 手动刷新:尽管缓存仍新鲜,也要真打一次上游——轮询间隔与成功 TTL
    // 同为 60s 时缓存恒新鲜,不穿透的话刷新按钮永远拿回上一轮的数。
    await registry.snapshot('acme', { force: true })
    expect(querier).toHaveBeenCalledTimes(2)

    await registry.snapshot('acme')
    expect(querier).toHaveBeenCalledTimes(2)
  })

  it('force 命中在途查询时共享同一次上游请求', async () => {
    const { registry } = makeRegistry()
    let release: (() => void) | undefined
    const querier = vi.fn(async (): Promise<UsageSnapshot> => {
      await new Promise<void>(resolve => { release = resolve })
      return { provider: 'acme', windows: [], fetchedAt: 0 }
    })
    registry.register('acme', querier)

    const first = registry.snapshot('acme', { force: true })
    const second = registry.snapshot('acme', { force: true })
    await vi.waitFor(() => { expect(release).toBeDefined() }, { timeout: 5000 })
    release?.()
    await Promise.all([first, second])
    // 连点刷新按钮不得放大账单接口压力:force 绕过的是缓存读,不是在途合并。
    expect(querier).toHaveBeenCalledTimes(1)
  })

  it('失败快照按更短负缓存复用，过期后即重试且成功答案仍享全 TTL', async () => {
    const { registry, advance } = makeRegistry({ ttlMs: 60_000, errorTtlMs: 10_000 })
    let fail = true
    const querier = vi.fn(async (): Promise<UsageSnapshot> => {
      if (fail) throw new Error('transient')
      return { provider: 'acme', windows: [{ id: 'a', label: 'A', remain: 9, unit: 'credits' }], fetchedAt: 0 }
    })
    registry.register('acme', querier)

    await registry.snapshot('acme')
    advance(5_000)
    await registry.snapshot('acme')
    // 负缓存窗口内不重试:挂掉的端点不被轮询打爆。
    expect(querier).toHaveBeenCalledTimes(1)

    advance(6_000)
    fail = false
    const recovered = await registry.snapshot('acme')
    // 11s > 10s:错误过期,恢复后第一次读取即重试,不再等满成功 TTL。
    expect(querier).toHaveBeenCalledTimes(2)
    expect(recovered?.error).toBeUndefined()

    advance(30_000)
    await registry.snapshot('acme')
    expect(querier).toHaveBeenCalledTimes(2)
  })

  it('替换注册清掉别名键缓存（kimi 归一到 moonshot）', async () => {
    const { registry } = makeRegistry()
    registry.register('moonshot', fixedQuerier([{ id: 'old', label: 'old', remain: 1, unit: 'cny' }]))
    await registry.snapshot('kimi')

    // 缓存按请求键 'kimi' 存:热替换 'moonshot' 注册若只删注册键,
    // 别名键里的旧答案会在下一个 TTL 内继续供应已被替换的 querier。
    registry.register('moonshot', fixedQuerier([{ id: 'new', label: 'new', remain: 2, unit: 'cny' }]))
    const snapshot = await registry.snapshot('kimi')
    expect(snapshot?.windows[0]?.id).toBe('new')
  })

  it('invalidate 按归一化匹配清除别名键缓存', async () => {
    const { registry } = makeRegistry()
    const querier = fixedQuerier([{ id: 'm', label: 'M', remain: 3, unit: 'cny' }])
    registry.register('moonshot', querier)

    await registry.snapshot('kimi')
    registry.invalidate('moonshot')
    await registry.snapshot('kimi')
    expect(querier).toHaveBeenCalledTimes(2)
  })

  it('被替换注册的在途旧查询结算后不得回写缓存', async () => {
    const { registry } = makeRegistry()
    let release: (() => void) | undefined
    const stale = vi.fn(async (): Promise<UsageSnapshot> => {
      await new Promise<void>(resolve => { release = resolve })
      return { provider: 'acme', windows: [{ id: 'old', label: 'old', remain: 1, unit: 'credits' }], fetchedAt: 0 }
    })
    registry.register('acme', stale)
    const pending = registry.snapshot('acme')
    await vi.waitFor(() => { expect(release).toBeDefined() }, { timeout: 5000 })

    // 查询在途时热替换注册:旧查询仍要把结果交还给发起它的调用方,
    // 但缓存里留下的必须是新 querier 的答案。
    const live = fixedQuerier([{ id: 'new', label: 'new', remain: 2, unit: 'credits' }])
    registry.register('acme', live)
    release?.()
    await pending
    expect(stale).toHaveBeenCalledTimes(1)

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.windows[0]?.id).toBe('new')
    expect(live).toHaveBeenCalledTimes(1)
  })

  it('推断路径连续读取共享缓存（回写身份校验按注册键）', async () => {
    const { registry } = makeRegistry()
    registry.setResolver(async () => ({ baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf' }))
    const sfQuerier = vi.fn(async context => ({
      provider: context.provider,
      windows: [{ id: 'sf', label: 'Balance', remain: 99, unit: 'cny' }],
      fetchedAt: 0,
    }))
    registry.register('siliconflow', sfQuerier, 'SiliconFlow')

    // 推断路径缓存键是请求键('my-cloud'),注册身份校验键是 'siliconflow':
    // 回写不得因请求键本身无注册而被拒,否则推断路径每次读取都真打上游。
    await registry.snapshot('my-cloud')
    await registry.snapshot('my-cloud')
    expect(sfQuerier).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight query between concurrent readers', async () => {
    const { registry } = makeRegistry()
    let release: (() => void) | undefined
    const querier = vi.fn(async (): Promise<UsageSnapshot> => {
      await new Promise<void>(resolve => { release = resolve })
      return { provider: 'acme', windows: [], fetchedAt: 0 }
    })
    registry.register('acme', querier)

    const first = registry.snapshot('acme')
    const second = registry.snapshot('acme')
    await vi.waitFor(() => { expect(release).toBeDefined() }, { timeout: 5000 })
    release?.()
    await Promise.all([first, second])
    // Two readers, one billing request: a page polling twice must not double
    // the cost of merely displaying a number.
    expect(querier).toHaveBeenCalledTimes(1)
  })

  it('folds a failed query into the snapshot instead of rejecting', async () => {
    const { registry } = makeRegistry()
    registry.register('acme', async () => { throw new Error('billing endpoint is down') })

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('billing endpoint is down')
    expect(snapshot?.windows).toEqual([])
  })

  it('keeps the last good windows when a refetch fails', async () => {
    const { registry, advance } = makeRegistry({ ttlMs: 100 })
    let fail = false
    registry.register('acme', async () => {
      if (fail) throw new Error('transient')
      return { provider: 'acme', windows: [{ id: 'a', label: 'A', remain: 9, unit: 'credits' }], fetchedAt: 0 }
    })

    await registry.snapshot('acme')
    fail = true
    advance(101)
    const snapshot = await registry.snapshot('acme')
    // A transient outage must not blank the number the user was reading.
    expect(snapshot?.windows).toEqual([{ id: 'a', label: 'A', remain: 9, unit: 'credits' }])
    expect(snapshot?.error).toContain('transient')
    // 折叠的旧答案必须自带 degraded 标记:客户端据此调暗展示,不把旧
    // 数字当新鲜值呈现。
    expect(snapshot?.degraded).toBe(true)
  })

  it('redacts the credential a failing endpoint quotes back', async () => {
    const { registry } = makeRegistry({ timeoutMs: 5000 })
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345'
    registry.register('acme', async () => { throw new Error(`rejected key ${secret} for account 42`) })

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).not.toContain(secret)
    expect(snapshot?.error).toContain('[redacted key]')
    expect(snapshot?.error).toContain('account 42')
  })

  it('invalidates one provider or every provider', async () => {
    const { registry } = makeRegistry()
    const acme = fixedQuerier([{ id: 'a', label: 'A', remain: 1, unit: 'credits' }])
    const other = vi.fn(async (): Promise<UsageSnapshot> => ({ provider: 'other', windows: [], fetchedAt: 0 }))
    registry.register('acme', acme)
    registry.register('other', other)

    await registry.snapshot('acme')
    await registry.snapshot('other')
    registry.invalidate('acme')
    await registry.snapshot('acme')
    await registry.snapshot('other')
    expect(acme).toHaveBeenCalledTimes(2)
    expect(other).toHaveBeenCalledTimes(1)

    registry.invalidate()
    await registry.snapshot('other')
    expect(other).toHaveBeenCalledTimes(2)
  })

  it('invalidates the cache when a querier is replaced', async () => {
    const { registry } = makeRegistry()
    const first = fixedQuerier([{ id: 'old', label: 'old', remain: 1, unit: 'credits' }])
    registry.register('acme', first)
    await registry.snapshot('acme')

    // Hot reload re-registers the same provider; the previous answer describes
    // a query that no longer exists.
    registry.register('acme', fixedQuerier([{ id: 'new', label: 'new', remain: 2, unit: 'credits' }]))
    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.windows[0]?.id).toBe('new')
  })

  it('keeps the live querier when a replaced registration is disposed', async () => {
    const { registry } = makeRegistry()
    const stale = fixedQuerier([{ id: 'old', label: 'old', remain: 1, unit: 'credits' }])
    const live = fixedQuerier([{ id: 'new', label: 'new', remain: 2, unit: 'credits' }])
    const disposeStale = registry.register('acme', stale)
    registry.register('acme', live)

    // The first registration was replaced before its disposer ran: disposing
    // it must not darken the live querier.
    disposeStale()

    expect(registry.has('acme')).toBe(true)
    expect(registry.providers()).toEqual(['acme'])
    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.windows[0]?.id).toBe('new')
    expect(live).toHaveBeenCalledTimes(1)
    expect(stale).not.toHaveBeenCalled()
  })

  it('withdraws its own registration on dispose', async () => {
    const { registry } = makeRegistry()
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 1, unit: 'credits' }])
    const dispose = registry.register('acme', querier)
    expect(registry.has('acme')).toBe(true)

    dispose()

    expect(registry.has('acme')).toBe(false)
    expect(registry.providers()).toEqual([])
    expect(await registry.snapshot('acme')).toBeUndefined()
  })

  it('rejects an empty provider key and a non-function querier', () => {
    const { registry } = makeRegistry()
    expect(() => registry.register('', async () => ({ provider: '', windows: [], fetchedAt: 0 }))).toThrow(TypeError)
    expect(() => registry.register('acme', undefined as never)).toThrow(TypeError)
  })

  it('times out a query that never settles', async () => {
    const { registry } = makeRegistry({ timeoutMs: 20 })
    registry.register('acme', async ({ signal }) => {
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => { reject(signal.reason ?? new Error('aborted')) })
      })
      return { provider: 'acme', windows: [], fetchedAt: 0 }
    })

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('timed out')
  })

  it('times out even when the querier ignores abort and never settles', async () => {
    // 回归:withDeadline 此前只 abort 不 race,querier 是公开扩展点,不理
    // abort 的挂死实现(或挂起的 credentials 服务)会让 inflight 条目永久
    // 残留,该 provider 的每次 snapshot 都返回同一个挂起 Promise——轮询
    // 端点对它永久挂起。deadline 必须靠 race 落地,不依赖对方配合。
    const { registry } = makeRegistry({ timeoutMs: 20 })
    registry.register('acme', async () => new Promise<UsageSnapshot>(() => {}))

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('timed out')

    // 超时后 inflight 条目必须已清理:下一次查询重新发起,而不是复用挂死
    // 的旧 Promise 永久挂起。
    const second = await registry.snapshot('acme')
    expect(second?.error).toContain('timed out')
  })

  it('carries a querier-reported error through the success path', async () => {
    // 回归:软失败契约是「空 windows + error」,转发层此前丢弃 error,浏览器
    // 只能看到「不上报额度」的绿点而非失败原因。
    const { registry } = makeRegistry()
    registry.register('acme', async () => ({
      provider: 'acme',
      windows: [],
      fetchedAt: 0,
      error: 'the balance endpoint reported no usable balance',
    }))

    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.error).toContain('no usable balance')
    expect(snapshot?.windows).toEqual([])
    // windows 是查询器本轮Fresh返回的空表,不是折叠的旧答案:不标 degraded。
    expect(snapshot?.degraded).toBeUndefined()
  })

  it('passes the resolved endpoint and credential to the querier', async () => {
    const { registry } = makeRegistry()
    const seen: unknown[] = []
    registry.setResolver(async provider => ({ baseURL: `https://${provider}.example`, apiKey: 'k' }))
    registry.register('acme', async context => {
      seen.push({ provider: context.provider, baseURL: context.baseURL, apiKey: context.apiKey })
      return { provider: context.provider, windows: [], fetchedAt: 0 }
    })

    await registry.snapshot('acme')
    expect(seen).toEqual([{ provider: 'acme', baseURL: 'https://acme.example', apiKey: 'k' }])
  })

  it('resolves snapshots via canonical provider aliases', async () => {
    const { registry } = makeRegistry()
    registry.register('moonshot', fixedQuerier([{ id: 'm', label: 'Moonshot', remain: 42, unit: 'cny' }]), 'Moonshot')

    expect(registry.has('kimi')).toBe(true)
    const snapshot = await registry.snapshot('kimi')
    expect(snapshot?.windows).toEqual([{ id: 'm', label: 'Moonshot', remain: 42, unit: 'cny' }])
  })

  it('infers querier from baseURL when custom provider ID is unregistered', async () => {
    const { registry } = makeRegistry()
    registry.setResolver(async () => ({ baseURL: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf' }))
    const sfQuerier = vi.fn(async context => ({
      provider: context.provider,
      windows: [{ id: 'sf', label: 'Balance', remain: 99, unit: 'cny' }],
      fetchedAt: 0,
    }))
    registry.register('siliconflow', sfQuerier, 'SiliconFlow')

    // 'my-cloud' is not directly registered and not an alias, but its baseURL is siliconflow.cn
    const snapshot = await registry.snapshot('my-cloud')
    expect(sfQuerier).toHaveBeenCalledTimes(1)
    expect(snapshot?.windows).toEqual([{ id: 'sf', label: 'Balance', remain: 99, unit: 'cny' }])
  })

  it('推断无果的 provider 在负缓存窗口内不重复跑 resolve', async () => {
    const { registry, advance } = makeRegistry({ unresolvedTtlMs: 30_000 })
    const resolver = vi.fn(async () => ({ baseURL: 'https://api.unmatched.example' }))
    registry.setResolver(resolver)

    await registry.snapshot('my-cloud')
    await registry.snapshot('my-cloud')
    // 轮询每 60s 一次,推断无果就别每轮都白读一遍 settings/credentials。
    expect(resolver).toHaveBeenCalledTimes(1)

    advance(31_000)
    await registry.snapshot('my-cloud')
    expect(resolver).toHaveBeenCalledTimes(2)
  })

  it('直接注册与推断负缓存互不影响，新注册让其让路', async () => {
    const { registry, advance } = makeRegistry({ unresolvedTtlMs: 30_000 })
    const resolver = vi.fn(async () => ({}))
    registry.setResolver(resolver)
    await registry.snapshot('acme')
    await registry.snapshot('acme')
    expect(resolver).toHaveBeenCalledTimes(1)

    // 直接注册同一名字:注册查表在负缓存判断之前,必须立即可用。
    const querier = fixedQuerier([{ id: 'a', label: 'A', remain: 1, unit: 'credits' }])
    registry.register('acme', querier)
    const snapshot = await registry.snapshot('acme')
    expect(snapshot?.windows).toEqual([{ id: 'a', label: 'A', remain: 1, unit: 'credits' }])
    // resolver 同时服务注册查询路径(每次查询都要解析端点/凭据),这里的
    // 计数把两条路径都算上;断言点是「注册查询不多跑推断负缓存的账」。
    expect(resolver).toHaveBeenCalledTimes(2)

    // 新注册也让其它 provider 的推断负缓存清零(可能变得可推断)。
    advance(1)
    await registry.snapshot('other-cloud')
    expect(resolver).toHaveBeenCalledTimes(3)
    registry.register('siliconflow', fixedQuerier([{ id: 's', label: 'S', remain: 2, unit: 'cny' }]))
    await registry.snapshot('other-cloud')
    expect(resolver).toHaveBeenCalledTimes(4)
  })

  it('applies the query deadline to the inference resolve, not just the querier', async () => {
    // 回归:fallback 推断路径此前裸 await resolveProvider,挂死的 resolver
    // (credentials 服务、DeepSeek 账户接口都是真实 I/O)会把 snapshot 永远
    // 挂住——轮询端点没有整体超时,浏览器只能干等。resolve 阶段与 querier
    // 同受 queryTimeoutMs 约束,超时按"无推断结果"处理。
    const { registry } = makeRegistry({ timeoutMs: 20 })
    let aborted = false
    registry.setResolver(async (_provider, signal) => {
      await new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true
          reject(signal.reason ?? new Error('aborted'))
        })
      })
      return { baseURL: 'https://api.siliconflow.cn/v1' }
    })
    const sfQuerier = vi.fn(async (): Promise<UsageSnapshot> => ({ provider: 'siliconflow', windows: [], fetchedAt: 0 }))
    registry.register('siliconflow', sfQuerier)

    const snapshot = await registry.snapshot('my-cloud')
    expect(snapshot).toBeUndefined()
    expect(aborted).toBe(true)
    expect(sfQuerier).not.toHaveBeenCalled()
  })

  it('官方 DeepSeek 两条路由都给出已查询快照，provider 是请求键', async () => {
    const registry = makeBuiltinRegistry()
    for (const key of ['deepseek-account', 'deepseek-official']) {
      const snapshot = await registry.snapshot(key)
      // undefined 正是 route 层写成 {provider, queried:false} 的东西，
      // 也就是界面上「不支持」的来源：非 undefined 即已查询。
      expect(snapshot).toBeDefined()
      expect(snapshot?.provider).toBe(key)
      expect(snapshot?.displayName).toBe('DeepSeek')
      expect(snapshot?.windows).toEqual([])
      expect(snapshot?.error).toBeUndefined()
    }
  })

  it('别名让两条官方路由在只注册 canonical deepseek 时也可查（修复的另一半）', async () => {
    // 只装 canonical 键:官方路由靠别名归一到它,缓存键仍是请求键本身,
    // 两个官方路由的答案不会与 deepseek 的互相串。
    const registry = makeBuiltinRegistry(['deepseek'])
    for (const key of ['deepseek-account', 'deepseek-official']) {
      expect(registry.has(key)).toBe(true)
      const snapshot = await registry.snapshot(key)
      expect(snapshot?.provider).toBe(key)
    }
  })

  it('对照：只装修复前的 9 条内置键时，两条官方路由的可见性完全由别名决定（修复前 undefined）', async () => {
    // 缺陷（界面显示「不支持」）由两个条件同时成立造成：内置注册表里没有这两个
    // 键，baseURL 推断也认不出官方路由（官方 provider 的 baseURL 在适配器默认值
    // 里、不落 profile，resolver 只能给出空答案 → 负缓存 → undefined）。
    // 先用替换后的归一化复现修复前行为（无官方别名），拿到当时的答案；再用
    // 真实归一化跑同一份注册表配置，答案相反——这个反差就是缺陷与修复的分界点，
    // 也说明「只注册旧 9 键却期望 undefined」只有在别名同时缺席时才成立。
    vi.resetModules()
    vi.doMock('../src/resolve.js', async importOriginal => {
      const actual = await importOriginal<typeof import('../src/resolve.js')>()
      return { ...actual, normalizeProviderKey: (key: string) => key.toLowerCase().replace(/[-_\s]/gu, '') }
    })
    try {
      const { ProviderUsageRegistry: PreFixRegistry } = await import('../src/registry.js')
      const preFix = new PreFixRegistry(new Context(), {
        cacheTtlMs: 60_000,
        errorCacheTtlMs: 10_000,
        unresolvedTtlMs: 60_000,
        queryTimeoutMs: 15_000,
        now: () => 1_000,
      })
      for (const key of PRE_FIX_BUILTIN_KEYS) {
        const entry = BUILTIN_USAGE_QUERIERS.get(key)
        if (entry === undefined) throw new Error(`内置注册表缺少 ${key}`)
        preFix.register(key, entry.querier, entry.displayName)
      }
      for (const key of ['deepseek-account', 'deepseek-official']) {
        // route 层把 undefined 写成 {provider, queried:false}，即界面上的「不支持」。
        expect(await preFix.snapshot(key)).toBeUndefined()
      }
    } finally {
      vi.doUnmock('../src/resolve.js')
      vi.resetModules()
    }

    // 修复后：同一份「旧 9 键」配置，别名把两条官方路由归一到 deepseek 注册，
    // 于是它们已可查——若有人拿掉别名，本断言立刻变红。
    const live = makeBuiltinRegistry(PRE_FIX_BUILTIN_KEYS)
    for (const key of ['deepseek-account', 'deepseek-official']) {
      expect(live.has(key)).toBe(true)
      expect((await live.snapshot(key))?.provider).toBe(key)
    }
  })
})

describe('safeMessage', () => {
  it('redacts jwt-shaped and sk-shaped secrets and query parameters', () => {
    const message = safeMessage(new Error('a eyJhbGciOi.eyJzdWIi.sig b sk-0123456789abcdef c ?access_token=zzz'))
    expect(message).not.toContain('eyJhbGciOi')
    expect(message).not.toContain('sk-0123456789abcdef')
    expect(message).toContain('[redacted]')
    expect(message).toContain('access_token=[redacted]')
    expect(message).not.toContain('zzz')
  })

  it('caps a pathological message', () => {
    expect(safeMessage(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(500)
  })
})
