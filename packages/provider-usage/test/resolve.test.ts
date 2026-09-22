/**
 * Generic endpoint and credential resolution.
 *
 * This is the piece that makes "every provider" true rather than a lookup
 * table: a querier never names a settings namespace, so a provider added to
 * the harness directory becomes queryable without touching this package.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createProviderResolver } from '../src/resolve.js'

/** One configurable-provider directory entry. */
function entry(provider: string, settingsNs: string, settingsPath: readonly string[] = []) {
  return { provider, displayName: provider, settingsNs, settingsPath }
}

/**
 * A fake ctx exposing only the services the resolver reads.
 *
 * `get` is the real Cordis lookup, so a missing service is modelled by
 * returning undefined for that name rather than by omitting the method.
 */
function fakeCtx(options: {
  entries?: ReturnType<typeof entry>[]
  sections?: Record<string, unknown>
  credentials?: Record<string, string>
  noLlm?: boolean
  noSettings?: boolean
  noCredentials?: boolean
} = {}): Context {
  const services: Record<string, unknown> = {}
  if (options.noLlm !== true) {
    services['llm'] = { listConfigurableProviders: () => options.entries ?? [] }
  }
  if (options.noSettings !== true) {
    services['settings'] = {
      describe: () => Object.entries(options.sections ?? {}).map(([ns, value]) => ({ ns, value })),
    }
  }
  if (options.noCredentials !== true) {
    services['credentials'] = {
      resolve: async (ref: string) => {
        const value = options.credentials?.[ref]
        return value === undefined ? undefined : { value, source: 'store' }
      },
    }
  }
  return { get: (name: string) => services[name] } as unknown as Context
}

const signal = new AbortController().signal

describe('createProviderResolver', () => {
  it('reads the endpoint and credential named by the provider profile', async () => {
    const ctx = fakeCtx({
      entries: [entry('deepseek', 'llm-deepseek')],
      sections: { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' } },
      credentials: { DEEPSEEK_API_KEY: 'sk-live' },
    })
    expect(await createProviderResolver(ctx)('deepseek', signal)).toEqual({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-live',
    })
  })

  it('follows a nested settingsPath into the profile object', async () => {
    const ctx = fakeCtx({
      // llm-pi-ai declares settingsPath ["providers", "<id>"].
      entries: [entry('muse', 'llm-pi-ai', ['providers', 'muse'])],
      sections: { 'llm-pi-ai': { providers: { muse: { apiKeyEnv: 'MUSE_API_KEY', baseURL: 'https://gw.example/v1' } } } },
      credentials: { MUSE_API_KEY: 'sk-muse' },
    })
    expect(await createProviderResolver(ctx)('muse', signal)).toEqual({
      baseURL: 'https://gw.example/v1',
      apiKey: 'sk-muse',
    })
  })

  it('resolves nothing for a provider the directory does not declare', async () => {
    const ctx = fakeCtx({ entries: [entry('deepseek', 'llm-deepseek')] })
    expect(await createProviderResolver(ctx)('mystery', signal)).toEqual({})
  })

  it('omits the credential when the reference is unset', async () => {
    const ctx = fakeCtx({
      entries: [entry('deepseek', 'llm-deepseek')],
      sections: { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      credentials: {},
    })
    // An unset credential is absent, not an empty string: a blank must never
    // masquerade as a configured secret.
    expect(await createProviderResolver(ctx)('deepseek', signal)).toEqual({})
  })

  it('omits a blank credential', async () => {
    const ctx = fakeCtx({
      entries: [entry('deepseek', 'llm-deepseek')],
      sections: { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      credentials: { DEEPSEEK_API_KEY: '' },
    })
    expect(await createProviderResolver(ctx)('deepseek', signal)).toEqual({})
  })

  it('reports the endpoint even with no credential service mounted', async () => {
    const ctx = fakeCtx({
      entries: [entry('deepseek', 'llm-deepseek')],
      sections: { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' } },
      noCredentials: true,
    })
    expect(await createProviderResolver(ctx)('deepseek', signal)).toEqual({ baseURL: 'https://api.deepseek.com' })
  })

  it.each([
    ['llm', { noLlm: true }],
    ['settings', { noSettings: true }],
  ])('resolves nothing when the %s service is absent', async (_name, options) => {
    const ctx = fakeCtx({ entries: [entry('deepseek', 'llm-deepseek')], ...options })
    expect(await createProviderResolver(ctx)('deepseek', signal)).toEqual({})
  })

  it('tolerates a profile that is not an object', async () => {
    const ctx = fakeCtx({
      entries: [entry('deepseek', 'llm-deepseek')],
      sections: { 'llm-deepseek': 'nonsense' },
    })
    expect(await createProviderResolver(ctx)('deepseek', signal)).toEqual({})
  })

  it('tolerates a settingsPath that walks off the section', async () => {
    const ctx = fakeCtx({
      entries: [entry('muse', 'llm-pi-ai', ['providers', 'missing'])],
      sections: { 'llm-pi-ai': { providers: {} } },
    })
    expect(await createProviderResolver(ctx)('muse', signal)).toEqual({})
  })

  it('reads the services on every call, not once at construction', async () => {
    // A deployment may mount settings after this plugin loads; capturing the
    // service at construction would keep the resolver permanently blind.
    const services: Record<string, unknown> = {}
    const ctx = { get: (name: string) => services[name] } as unknown as Context
    const resolve = createProviderResolver(ctx)
    expect(await resolve('deepseek', signal)).toEqual({})

    services['llm'] = { listConfigurableProviders: () => [entry('deepseek', 'llm-deepseek')] }
    services['settings'] = { describe: () => [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' } }] }
    services['credentials'] = { resolve: async () => ({ value: 'sk-late', source: 'store' }) }
    expect(await resolve('deepseek', signal)).toEqual({ baseURL: 'https://api.deepseek.com', apiKey: 'sk-late' })
  })

  it('returns the endpoint alone when the signal aborts mid-resolution', async () => {
    const controller = new AbortController()
    const ctx = fakeCtx({
      entries: [entry('deepseek', 'llm-deepseek')],
      sections: { 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' } },
      credentials: { DEEPSEEK_API_KEY: 'sk-live' },
    })
    const services = { get: (ctx as unknown as { get: (n: string) => unknown }).get.bind(ctx) }
    const aborting: Context = {
      get: (name: string) => {
        if (name === 'credentials') {
          return {
            resolve: async () => {
              controller.abort(new Error('cancelled'))
              return { value: 'sk-live', source: 'store' }
            },
          }
        }
        return services.get(name)
      },
    } as unknown as Context

    // An operator cancel must not be reported as a credential failure.
    expect(await createProviderResolver(aborting)('deepseek', controller.signal)).toEqual({
      baseURL: 'https://api.deepseek.com',
    })
  })

  it('re-resolves the credential on each call so a rotation is picked up', async () => {
    let value = 'sk-old'
    const ctx = {
      get: (name: string) => {
        if (name === 'llm') return { listConfigurableProviders: () => [entry('deepseek', 'llm-deepseek')] }
        if (name === 'settings') return { describe: () => [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }] }
        if (name === 'credentials') return { resolve: async () => ({ value, source: 'store' }) }
        return undefined
      },
    } as unknown as Context

    const resolve = createProviderResolver(ctx)
    expect((await resolve('deepseek', signal)).apiKey).toBe('sk-old')
    value = 'sk-new'
    expect((await resolve('deepseek', signal)).apiKey).toBe('sk-new')
  })
})
