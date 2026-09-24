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
import { inferProviderFromBaseUrl, normalizeProviderKey } from './resolve.js'
import type { AccountWalletBalance, ProviderUsageQuerier, UsageSnapshot } from './types.js'

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
export const DEFAULT_CACHE_TTL_MS = 60_000

/** How long one query may run before it is abandoned. */
export const DEFAULT_QUERY_TIMEOUT_MS = 15_000

/** Constructor options. */
export interface ProviderUsageRegistryOptions {
  /** Cache lifetime in milliseconds; tests pin this to drive refetches. */
  cacheTtlMs?: number
  /** Per-query deadline in milliseconds. */
  queryTimeoutMs?: number
  /** Clock, injectable so tests never sleep. */
  now?: () => number
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
  private readonly queryTimeoutMs: number
  private readonly now: () => number

  constructor(ctx: Context, options: ProviderUsageRegistryOptions = {}) {
    super(ctx, 'providerUsage')
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
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
    this.cache.delete(provider)
    return () => {
      // Only withdraw our own registration: a reload may have replaced it
      // already, and dropping the newer querier would leave the provider dark.
      if (this.registrations.get(provider) === registration) this.registrations.delete(provider)
      this.cache.delete(provider)
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
  async snapshot(provider: string): Promise<UsageSnapshot | undefined> {
    const registration = this.registrations.get(provider)
      ?? this.registrations.get(normalizeProviderKey(provider))
    if (registration !== undefined) {
      return this.snapshotWithRegistration(provider, registration)
    }

    // Heuristic fallback: if provider has no direct or alias registration,
    // resolve its baseURL and infer the querier (e.g. for custom providers like "my-silicon").
    try {
      const controller = new AbortController()
      const resolved = await this.resolveProvider(provider, controller.signal)
      const inferred = inferProviderFromBaseUrl(resolved.baseURL)
      if (inferred !== undefined) {
        const inferredReg = this.registrations.get(inferred)
        if (inferredReg !== undefined) {
          return this.snapshotWithRegistration(provider, inferredReg)
        }
      }
    } catch {
      // Resolution failed
    }

    return undefined
  }

  private async snapshotWithRegistration(provider: string, registration: Registration): Promise<UsageSnapshot> {
    const cached = this.cache.get(provider)
    const now = this.now()
    if (cached !== undefined && cached.expiresAt > now) return cached.snapshot

    const pending = this.inflight.get(provider)
    if (pending !== undefined) return pending

    const query = this.run(provider, registration).then(snapshot => {
      this.cache.set(provider, { snapshot, expiresAt: this.now() + this.cacheTtlMs })
      return snapshot
    }).finally(() => {
      this.inflight.delete(provider)
    })
    this.inflight.set(provider, query)
    return query
  }

  /** Drop one provider's cached answer, or every answer when no provider is named. */
  invalidate(provider?: string): void {
    if (provider === undefined) this.cache.clear()
    else this.cache.delete(provider)
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
      return {
        ...base,
        ...snapshot.plan === undefined ? {} : { plan: snapshot.plan },
        windows: snapshot.windows,
        fetchedAt,
      }
    } catch (error: unknown) {
      return {
        ...base,
        // A failed refetch keeps the last good windows: the previous answer is
        // stale, not wrong, and blanking it hides the very number the user
        // opened the pill to read.
        ...previous?.plan === undefined ? {} : { plan: previous.plan },
        windows: previous?.windows ?? [],
        fetchedAt,
        error: safeMessage(error),
      }
    }
  }

  /** Race one query against the deadline and the caller's abort. */
  private async withDeadline(provider: string, querier: ProviderUsageQuerier): Promise<UsageSnapshot> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error('query timed out'))
    }, this.queryTimeoutMs)
    timer.unref?.()
    try {
      return await this.resolve(provider, querier, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Build the query context and run the querier.
   *
   * The credential and endpoint come from a resolver the caller installs, so
   * this module stays free of settings and credentials imports: built-ins use
   * the harness directory, tests inject a stub.
   */
  private resolveProvider: ((provider: string, signal: AbortSignal) => Promise<{
    baseURL?: string
    apiKey?: string
    accountWallets?: AccountWalletBalance[]
    accountError?: string
  }>) = async () => ({})

  /** Install the resolver used to fill each query's endpoint and credential. */
  setResolver(resolver: (provider: string, signal: AbortSignal) => Promise<{
    baseURL?: string
    apiKey?: string
    accountWallets?: AccountWalletBalance[]
    accountError?: string
  }>): void {
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
