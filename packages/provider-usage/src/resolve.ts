/**
 * Generic endpoint and credential resolution for one provider route.
 *
 * A querier must not have to know where the harness keeps a provider's
 * profile: that is what makes "support every provider" real instead of a pile
 * of per-provider hardcodings. Resolution therefore goes through the harness's
 * own directories rather than a lookup table of our own:
 *
 * 1. `llm.listConfigurableProviders()` names each provider's settings
 *    namespace and the path from that section to its profile object — the same
 *    directory the configuration surfaces use.
 * 2. The profile's `baseURL` and `apiKeyEnv` fields are read out of that
 *    section.
 * 3. `apiKeyEnv` is a credential *reference*, so its value is resolved through
 *    `ctx.credentials` — the one seam that knows about the environment, the
 *    provider-managed store, and `.env` files.
 *
 * A provider that publishes neither is resolved as "no endpoint, no
 * credential", which a querier reports as nothing-to-show rather than a
 * failure.
 *
 * @module provider-usage/resolve
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

/** What a querier receives for one provider route. */
export interface ResolvedProvider {
  /** Endpoint the provider's models are served from, when its profile names one. */
  baseURL?: string
  /** Resolved credential value, when the provider has one configured. */
  apiKey?: string
}

/** Read a nested path out of one settings section. */
function atPath(section: unknown, path: readonly string[]): unknown {
  let current = section
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Read a non-empty string field. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The provider's profile object, or `undefined` when the directory has none. */
function profileOf(section: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  const value = atPath(section, path)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Build the resolver the registry calls before each query.
 *
 * Every dependency is read through `ctx.get` at call time rather than
 * captured at construction: a deployment may mount the settings or credentials
 * service after this plugin loads, and a captured `undefined` would keep the
 * resolver permanently blind.
 *
 * @param ctx - the plugin context carrying the optional services.
 * @returns a resolver mapping one provider route to its endpoint and credential.
 */
export function createProviderResolver(ctx: Context): (provider: string, signal: AbortSignal) => Promise<ResolvedProvider> {
  return async (provider, signal) => {
    const llm = ctx.get('llm')
    if (llm === undefined) return {}

    const entry = llm.listConfigurableProviders().find(candidate => candidate.provider === provider)
    if (entry === undefined) return {}

    // DSH 0.1.7 removed the namespace section read (`settings.get(ns)`): the
    // forms service projects Loader profile entries, so the section is the
    // resolved value of the descriptor keyed by the directory's settingsNs.
    const section = ctx.get('settings')?.describe().find(candidate => candidate.ns === entry.settingsNs)?.value
    const profile = profileOf(section, entry.settingsPath)
    const baseURL = str(profile?.['baseURL'])
    const apiKeyEnv = str(profile?.['apiKeyEnv'])

    let apiKey: string | undefined
    const credentials = ctx.get('credentials')
    if (apiKeyEnv !== undefined && credentials !== undefined) {
      // Re-read rather than cache: a credential rotated between two queries
      // would otherwise be answered with a stale value and the user would see
      // a failure they cannot explain.
      const resolved = await credentials.resolve(credentialRef(apiKeyEnv))
      if (signal.aborted) return baseURL === undefined ? {} : { baseURL }
      apiKey = resolved?.value
    }

    return {
      ...baseURL === undefined ? {} : { baseURL },
      ...apiKey === undefined || apiKey === '' ? {} : { apiKey },
    }
  }
}
