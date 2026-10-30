/**
 * The provider-usage registry: who can answer "how much is left?" for a
 * provider route, plus the cache that keeps the browser's poll from becoming a
 * billing request per second.
 *
 * The harness has no notion of provider quotas, so this package owns the seam
 * instead of inventing a host capability: a plugin that knows a provider's
 * billing endpoint registers a querier, and the browser half asks this
 * registry through the status route. Providers with no querier are a normal
 * state, not an error — {@link ProviderUsageRegistry.providers} simply omits
 * them and the surface says so.
 *
 * @module provider-usage/registry
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { inferProviderFromBaseUrl, normalizeProviderKey, type ResolvedProvider } from './resolve.js'
import type { ProviderUsageQuerier, UsageSnapshot } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The provider-usage registry.
     *
     * Declared so a plugin that owns a provider can register its querier with
     * full types — the intended way to extend this package. Access is
     * optional: a deployment without this plugin has no `providerUsage`, so a
     * consumer waits for it with `ctx.inject(['providerUsage'], …)` rather
     * than declaring it in `inject`.
     */
    providerUsage: ProviderUsageRegistry
  }
}

/** How long one provider's answer is reused before the next read refetches. */
const DEFAULT_CACHE_TTL_MS = 60_000

/** 失败答案的复用时长:错误没有成功答案的保质期,按更短负缓存处理。 */
const DEFAULT_ERROR_CACHE_TTL_MS = 10_000

/** 无推断结果(`snapshot` 为 undefined)的负缓存时长,过期后才再次尝试推断。 */
const DEFAULT_UNRESOLVED_TTL_MS = 60_000

/** How long one query may run before it is abandoned. */
const DEFAULT_QUERY_TIMEOUT_MS = 15_000

/** Constructor options. */
interface ProviderUsageRegistryOptions {
  /** Cache lifetime in milliseconds; tests pin this to drive refetches. */
  cacheTtlMs?: number
  /** 失败快照的负缓存时长;过期后第一次读取即重试上游。 */
  errorCacheTtlMs?: number
  /** 无推断结果(未注册且 baseURL 推断不出 querier)的负缓存时长。 */
  unresolvedTtlMs?: number
  /** Per-query deadline in milliseconds. */
  queryTimeoutMs?: number
  /** Clock, injectable so tests never sleep. */
  now?: () => number
}

/**
 * {@link ProviderUsageRegistry.snapshot} 的读取选项。
 */
interface ProviderUsageSnapshotOptions {
  /**
   * 绕过缓存读(在途合并照常生效):面板手动刷新用,自动轮询不带。
   * 命中在途查询时返回该查询的结果——它至多早于点击一个查询时长,
   * 不为连点按钮放大账单接口压力。
   */
  force?: boolean
}

/** One registered querier plus its registration-time metadata. */
interface Registration {
  querier: ProviderUsageQuerier
  /** Human-readable name used in the snapshot when the harness directory has none. */
  displayName?: string
}

/** One cached answer with the moment it stops being reusable. */
interface CacheEntry {
  snapshot: UsageSnapshot
  expiresAt: number
}

/** The resolver signature; see {@link ProviderUsageRegistry.setResolver}. */
type Resolver = (provider: string, signal: AbortSignal) => Promise<ResolvedProvider>

/**
 * Run one operation under a deadline that also aborts the signal it receives.
 *
 * 超时先 abort 再 reject：resolver/querier 内部的 I/O（credentials 服务、
 * 外部账户接口）未必监听 abort，等它自己结束就失去了 deadline 的保护意义；
 * 只 abort 不 race 也是假的 deadline——操作永不 settle 时在途条目会永久
 * 残留，该 provider 的每次读取都被同一个挂起 Promise 拖死。race 保证超时
 * 必然结算，迟到的 rejection 挂空 catch 兜住，不变成 unhandled rejection。
 *
 * @param timeoutMs - deadline in milliseconds.
 * @param timeoutMessage - rejection reason and abort reason on expiry.
 * @param run - the operation, receiving the abort signal.
 * @returns the operation's value, or rejects with the timeout reason.
 */
async function underDeadline<T>(timeoutMs: number, timeoutMessage: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error(timeoutMessage)
      controller.abort(reason)
      reject(reason)
    }, timeoutMs)
  })
  timer?.unref?.()
  // race 先被操作结算时，timedOut 稍后的 reject 会成为 unhandled rejection；
  // 同理操作在超时后迟到 reject 时也一样。两边都挂空 catch 吞掉。
  timedOut.catch(() => {})
  const work = run(controller.signal)
  work.catch(() => {})
  try {
    return await Promise.race([work, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** One querier-answer shape defect, named for the provider that returned it. */
function invalidSnapshot(provider: string, reason: string): Error {
  return new Error(`provider-usage: querier for "${provider}" returned an invalid snapshot: ${reason}`)
}

/**
 * Validate one querier answer before it reaches the browser.
 *
 * A querier is a public extension point, so a third-party implementation can
 * return anything at runtime. The client renders `windows` and `rateLimit`
 * directly, so a malformed answer would throw inside the pill's render — and
 * the host turns a render throw into a permanent entry abdication (the pill
 * disappears until a page reload). Folding the defect into the ordinary failure
 * path keeps the surface alive and reports which provider returned what.
 *
 * Fields the registry itself overwrites (`provider`, `fetchedAt`) are not
 * validated; every field the surface renders is.
 *
 * @param provider - provider route key the answer belongs to (for the message).
 * @param value - the querier's raw answer.
 */
function assertQuerierSnapshot(provider: string, value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidSnapshot(provider, 'not an object')
  const snapshot = value as Record<string, unknown>
  const windows = snapshot['windows']
  if (!Array.isArray(windows)) throw invalidSnapshot(provider, 'windows is not an array')
  for (const [index, item] of windows.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalidSnapshot(provider, `windows[${index}] is not an object`)
    const window = item as Record<string, unknown>
    for (const key of ['id', 'label', 'unit'] as const) {
      if (typeof window[key] !== 'string') throw invalidSnapshot(provider, `windows[${index}].${key} is not a string`)
    }
    if (window['id'] === '') throw invalidSnapshot(provider, `windows[${index}].id is empty`)
    for (const key of ['remain', 'limit'] as const) {
      const amount = window[key]
      if (amount !== undefined && (typeof amount !== 'number' || !Number.isFinite(amount))) {
        throw invalidSnapshot(provider, `windows[${index}].${key} is not a finite number`)
      }
    }
    const resetsAt = window['resetsAt']
    if (resetsAt !== undefined && (typeof resetsAt !== 'string' || Number.isNaN(new Date(resetsAt).getTime()))) {
      throw invalidSnapshot(provider, `windows[${index}].resetsAt is not a parseable instant`)
    }
    if (window['blocked'] !== undefined && typeof window['blocked'] !== 'boolean') {
      throw invalidSnapshot(provider, `windows[${index}].blocked is not a boolean`)
    }
  }
  for (const key of ['plan', 'error'] as const) {
    if (snapshot[key] !== undefined && typeof snapshot[key] !== 'string') throw invalidSnapshot(provider, `${key} is not a string`)
  }
  const rateLimit = snapshot['rateLimit']
  if (rateLimit !== undefined) {
    if (typeof rateLimit !== 'object' || rateLimit === null || Array.isArray(rateLimit)) throw invalidSnapshot(provider, 'rateLimit is not an object')
    const resetAt = (rateLimit as Record<string, unknown>)['resetAt']
    if (resetAt !== undefined && (typeof resetAt !== 'number' || !Number.isFinite(resetAt))) {
      throw invalidSnapshot(provider, 'rateLimit.resetAt is not a finite number')
    }
  }
}

/**
 * Registrations, resolution, and the cache, as the `ctx.providerUsage`
 * service. One instance serves the whole host; registrations are disposed with
 * the fiber that made them, exactly like every other Cordis service.
 */
export class ProviderUsageRegistry extends Service {
  private readonly registrations = new Map<string, Registration>()
  private readonly cache = new Map<string, CacheEntry>()
  /** In-flight queries keyed by provider, so concurrent readers share one request. */
  private readonly inflight = new Map<string, Promise<UsageSnapshot>>()
  private readonly cacheTtlMs: number
  private readonly errorCacheTtlMs: number
  private readonly unresolvedTtlMs: number
  private readonly queryTimeoutMs: number
  private readonly now: () => number
  /** 推断无果的 provider → 负缓存到期时刻;直接/别名注册查表不受它影响。 */
  private readonly unresolved = new Map<string, number>()
  /**
   * 端点/凭据解析器，由调用方安装（默认为空答案）。
   *
   * 解析器由调用方注入，本模块因此不 import settings/credentials：内置 resolver
   * 读宿主目录，测试注入 stub。
   */
  private resolveProvider: Resolver = async () => ({})

  constructor(ctx: Context, options: ProviderUsageRegistryOptions = {}) {
    super(ctx, 'providerUsage')
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.errorCacheTtlMs = options.errorCacheTtlMs ?? DEFAULT_ERROR_CACHE_TTL_MS
    this.unresolvedTtlMs = options.unresolvedTtlMs ?? DEFAULT_UNRESOLVED_TTL_MS
    this.queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
    this.now = options.now ?? Date.now
  }

  /**
   * Offer a usage query for one provider route.
   *
   * Registering twice for the same provider replaces the previous querier,
   * which is what keeps hot reload idempotent: a plugin reloaded in place
   * re-registers its provider instead of failing on the stale one.
   *
   * @param provider - provider route key the querier answers for.
   * @param querier - the query itself.
   * @param displayName - human-readable provider name for the snapshot.
   * @returns disposer that withdraws this querier, unless a newer registration
   * has already replaced it (the provider's cache entry is dropped either way).
   */
  register(provider: string, querier: ProviderUsageQuerier, displayName?: string): () => void {
    if (provider === '') throw new TypeError('provider-usage: a querier needs a provider route key')
    if (typeof querier !== 'function') throw new TypeError('provider-usage: a querier must be a function')
    const registration: Registration = { querier, ...displayName === undefined ? {} : { displayName } }
    this.registrations.set(provider, registration)
    // A replaced querier invalidates whatever the last one said: the answer on
    // screen describes a query that no longer exists.
    this.clearCacheFor(provider)
    // 新注册可能让此前推断无果的 provider 变得可推断,负缓存一并让路。
    this.unresolved.clear()
    return () => {
      // Only withdraw our own registration: a reload may have replaced it
      // already, and dropping the newer querier would leave the provider dark.
      if (this.registrations.get(provider) === registration) this.registrations.delete(provider)
      this.clearCacheFor(provider)
    }
  }

  /**
   * 清掉解析到同一规范 provider 的所有缓存键(含别名键)。
   *
   * 缓存按「请求键」存(kimi、Moonshot 各一条),注册键往往只有规范形式
   * (moonshot);注册替换/失效若只删注册键,别名键里的旧答案会在下一个
   * TTL 内继续供应已被替换的 querier 的结果。
   */
  private clearCacheFor(provider: string): void {
    const normalized = normalizeProviderKey(provider)
    for (const key of [...this.cache.keys()]) {
      if (key === provider || normalizeProviderKey(key) === normalized) this.cache.delete(key)
    }
  }

  /** Provider routes with a querier, in registration order. */
  providers(): readonly string[] {
    return [...this.registrations.keys()]
  }

  /** Whether one provider route has a querier. */
  has(provider: string): boolean {
    return this.registrations.has(provider) || this.registrations.has(normalizeProviderKey(provider))
  }

  /**
   * Read one provider's usage, from cache when it is still fresh.
   *
   * A failed query never rejects: it resolves to a snapshot carrying `error`,
   * because a billing endpoint being down must not break the page that shows
   * what is left. When a previous answer exists the failure keeps its windows
   * and only annotates the error, so a transient outage does not blank the
   * number the user was reading.
   *
   * @param provider - provider route key to resolve.
   * @returns the snapshot, or `undefined` when no querier is registered.
   */
  async snapshot(provider: string, options: ProviderUsageSnapshotOptions = {}): Promise<UsageSnapshot | undefined> {
    // 缓存/在途合并按「请求键」走:端点与凭据按请求键解析,同一注册的
    // 两个别名路由可能配了不同账号,答案不得互串;注册身份校验按
    // 「注册键」走(见 snapshotWithRegistration 的回写核对)。
    const normalized = normalizeProviderKey(provider)
    const direct = this.registrations.get(provider)
    // 直接注册键优先，别名键次之；缓存/在途合并仍按「请求键」走。
    const lookupKey = direct !== undefined ? provider : normalized
    const registration = direct ?? this.registrations.get(normalized)
    if (registration !== undefined) {
      return this.snapshotWithRegistration(provider, lookupKey, registration, options.force === true)
    }

    // 推断无果的负缓存:未注册且推断不出 querier 的 provider,每次轮询
    // 都会白跑一遍 settings/credentials 解析;负缓存窗口内直接回答
    // 「无 querier」。直接/别名注册查表在上方,不受它影响。
    const now = this.now()
    const unresolvedUntil = this.unresolved.get(provider)
    if (unresolvedUntil !== undefined && unresolvedUntil > now) return undefined

    // Heuristic fallback: if provider has no direct or alias registration,
    // resolve its baseURL and infer the querier (e.g. for custom providers like "my-silicon").
    // resolve 阶段与注册路径同受 queryTimeoutMs 约束（resolveWithDeadline）：
    // resolver 会读 settings/credentials，DeepSeek 无键路径还会发网络请求，
    // 挂死的 resolver 若无 deadline 会把轮询端点整个拖住（route 层没有
    // 整体超时兜底，浏览器只能干等到自身超时）。
    try {
      const resolved = await this.resolveWithDeadline(provider)
      const inferred = inferProviderFromBaseUrl(resolved.baseURL)
      if (inferred !== undefined) {
        const inferredReg = this.registrations.get(inferred)
        if (inferredReg !== undefined) {
          return this.snapshotWithRegistration(provider, inferred, inferredReg, options.force === true)
        }
      }
    } catch {
      // Resolution failed
    }

    this.unresolved.set(provider, this.now() + this.unresolvedTtlMs)
    return undefined
  }

  /**
   * Run the resolver under the query deadline.
   *
   * 与 {@link withDeadline}（querier 路径）同预算；失败（含超时）由调用方
   * catch 成 "无推断结果"。
   */
  private async resolveWithDeadline(provider: string): Promise<ResolvedProvider> {
    return underDeadline(this.queryTimeoutMs, 'provider resolution timed out', signal => this.resolveProvider(provider, signal))
  }

  private async snapshotWithRegistration(cacheKey: string, lookupKey: string, registration: Registration, force: boolean): Promise<UsageSnapshot> {
    const now = this.now()
    if (!force) {
      const cached = this.cache.get(cacheKey)
      if (cached !== undefined && cached.expiresAt > now) return cached.snapshot
    }

    const pending = this.inflight.get(cacheKey)
    if (pending !== undefined) return pending

    const query = this.run(cacheKey, registration).then(snapshot => {
      // 回写前核对注册身份:热替换/注销后结算的旧查询仍要把结果交还给
      // 发起它的调用方,但不得把它描述的已不存在的行为写进缓存——否则
      // 下一个 TTL 内每次读取都在供应旧 querier 的答案。
      if (this.registrations.get(lookupKey) === registration) {
        this.cache.set(cacheKey, {
          snapshot,
          // 失败按更短负缓存:账单接口恢复后第一次读取即重试,不必等满
          // 一个成功 TTL。自动轮询间隔等于成功 TTL,失败态的重试频率
          // 上界不变(每读者每分钟一次),只把恢复时延从分钟级降到秒级。
          expiresAt: this.now() + (snapshot.error === undefined ? this.cacheTtlMs : this.errorCacheTtlMs),
        })
      }
      return snapshot
    }).finally(() => {
      this.inflight.delete(cacheKey)
    })
    this.inflight.set(cacheKey, query)
    return query
  }

  /** Drop one provider's cached answer, or every answer when no provider is named. */
  invalidate(provider?: string): void {
    if (provider === undefined) this.cache.clear()
    else this.clearCacheFor(provider)
  }

  /** Run one query under a deadline, folding every failure into the snapshot. */
  private async run(provider: string, registration: Registration): Promise<UsageSnapshot> {
    const fetchedAt = this.now()
    const previous = this.cache.get(provider)?.snapshot
    const base = {
      provider,
      ...registration.displayName === undefined ? {} : { displayName: registration.displayName },
    }
    try {
      const snapshot = await this.withDeadline(provider, registration.querier)
      // 公开扩展点：第三方 querier 的形状缺陷在越过 wire 之前折叠成失败快照，
      // 绝不让 client 在渲染期抛错（宿主会把该 entry 永久 abdicate）。
      assertQuerierSnapshot(provider, snapshot)
      return {
        ...base,
        ...snapshot.plan === undefined ? {} : { plan: snapshot.plan },
        // 查询器用「空 windows + error」表达软失败（端点不可用、无可用余额
        // 等）——这是 types 契约的一半；不透传的话软失败到浏览器就成了
        // 「该 provider 不上报额度」的绿点，失败原因蒸发。错误文本过
        // safeMessage，与 catch 分支同一脱敏口径。
        ...snapshot.error === undefined ? {} : { error: safeMessage(snapshot.error) },
        windows: snapshot.windows,
        fetchedAt,
      }
    } catch (error: unknown) {
      // 承接旧答案时带上 degraded:客户端据此调暗展示,不把旧数字当作
      // 新鲜值呈现——没有这个标记,圆点照绿、文案照常,过期无从感知。
      const degraded = previous !== undefined
      return {
        ...base,
        // A failed refetch keeps the last good windows: the previous answer is
        // stale, not wrong, and blanking it hides the very number the user
        // opened the pill to read.
        ...previous?.plan === undefined ? {} : { plan: previous.plan },
        windows: previous?.windows ?? [],
        fetchedAt,
        error: safeMessage(error),
        ...degraded ? { degraded: true } : {},
      }
    }
  }

  /** Race one query against the deadline (querier 是公开扩展点，同样受 deadline 保护). */
  private async withDeadline(provider: string, querier: ProviderUsageQuerier): Promise<UsageSnapshot> {
    return underDeadline(this.queryTimeoutMs, 'query timed out', signal => this.resolve(provider, querier, signal))
  }

  /** Install the resolver used to fill each query's endpoint and credential. */
  setResolver(resolver: Resolver): void {
    this.resolveProvider = resolver
  }

  private async resolve(provider: string, querier: ProviderUsageQuerier, signal: AbortSignal): Promise<UsageSnapshot> {
    const resolved = await this.resolveProvider(provider, signal)
    if (signal.aborted) throw signal.reason ?? new Error('query aborted')
    return querier({
      provider,
      ...resolved.baseURL === undefined ? {} : { baseURL: resolved.baseURL },
      ...resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey },
      ...resolved.accountWallets === undefined ? {} : { accountWallets: resolved.accountWallets },
      ...resolved.accountError === undefined ? {} : { accountError: resolved.accountError },
      signal,
    })
  }
}

/**
 * Redact token-like material from a failure before it reaches the browser.
 *
 * A billing error body may quote the credential it rejected, so every message
 * that crosses the wire goes through here first — the same posture the
 * WorkBuddy card takes with its own upstream errors.
 */
export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, '[redacted key]')
    .replace(/(\b(?:code|token|refresh_token|access_token|api_?key)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}
