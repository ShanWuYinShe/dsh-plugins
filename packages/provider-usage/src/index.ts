/**
 * provider-usage — the composer-dock usage readout for every LLM provider.
 *
 * The harness models adapters and model lists but has no notion of a provider
 * quota, and providers disagree wildly about how (and whether) they disclose
 * one. So this package owns the seam rather than assuming a shape:
 *
 * - the host registers `ctx.providerUsage` and installs queriers for the
 *   providers it can answer for — built-ins for the documented ones, and any
 *   plugin may register its own for a provider it owns;
 * - endpoint and credential resolution reads the harness's own
 *   configurable-provider directory and credentials service, so a querier
 *   never hardcodes where a profile lives;
 * - the browser half renders one pill in `conversation.composer.dock` beside
 *   the existing turn/usage pills, showing the current session provider's
 *   remaining quota.
 *
 * @module provider-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import { BUILTIN_USAGE_QUERIERS } from './providers.js'
import { ProviderUsageRegistry } from './registry.js'
import { createProviderResolver } from './resolve.js'
import { registerProviderUsageRoute } from './route.js'
import { PROVIDER_USAGE_PATH } from './types.js'

export const name = 'provider-usage'

/**
 * No hard dependencies.
 *
 * Every service this plugin uses is read through `ctx.get` at the moment it
 * is needed (see {@link createProviderResolver} and {@link registerProviderUsageRoute}),
 * because each one is genuinely optional: without `llm` there is no provider
 * directory to resolve endpoints from, without `settings`/`credentials`
 * queries run unauthenticated, and without `webServer` the host half is inert.
 * Declaring any of them in `inject` would make the whole plugin refuse to load
 * in a profile that omits it — a pill that cannot report is a better outcome
 * than a plugin that cannot mount.
 */
export const inject: string[] = []

export { ProviderUsageRegistry, DEFAULT_CACHE_TTL_MS, DEFAULT_QUERY_TIMEOUT_MS, safeMessage } from './registry.js'
export type { ProviderUsageRegistryOptions } from './registry.js'
export { createProviderResolver } from './resolve.js'
export type { ResolvedProvider } from './resolve.js'
export { BUILTIN_USAGE_QUERIERS, deepseekUsage, moonshotUsage, openrouterUsage } from './providers.js'
export {
  providerUsageHandler,
  registerProviderUsageRoute,
  type ProviderUsageRouteOptions,
} from './route.js'
export {
  PROVIDER_USAGE_PATH,
  type ProviderUsageContext,
  type ProviderUsageQuerier,
  type UsageSnapshot,
  type UsageWindow,
} from './types.js'

/**
 * Mount the registry, its resolver, and the built-in queriers.
 *
 * @param ctx - the Cordis plugin context.
 * @returns nothing; the service lives with the plugin's fiber.
 */
export function apply(ctx: Context): void {
  const registry = new ProviderUsageRegistry(ctx)

  // The resolver reads the harness directories lazily on every query, so the
  // services it needs may be mounted after this plugin without blinding it.
  registry.setResolver(createProviderResolver(ctx))

  for (const [provider, entry] of BUILTIN_USAGE_QUERIERS) {
    registry.register(provider, entry.querier, entry.displayName)
  }

  registerProviderUsageRoute(ctx, { registry, path: PROVIDER_USAGE_PATH })
}
