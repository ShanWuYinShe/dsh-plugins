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
import type { AccountClientMetadata, AccountWallet } from '@deepseek-ai/dsh-deepseek-account'
import { str } from './provider-shared.js'
import type { AccountWalletBalance } from './types.js'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'

/** What a querier receives for one provider route. */
export interface ResolvedProvider {
  /** Endpoint the provider's models are served from, when its profile names one. */
  baseURL?: string
  /** Resolved credential value, when the provider has one configured. */
  apiKey?: string
  /** DeepSeek OAuth wallets (keyless fallback); see ProviderUsageContext. */
  accountWallets?: AccountWalletBalance[]
  /** Keyless-fallback failure text. */
  accountError?: string
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

/** The provider's profile object, or `undefined` when the directory has none. */
function profileOf(section: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  const value = atPath(section, path)
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Known provider route aliases normalized to their canonical provider keys. */
export const CANONICAL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  kimi: 'moonshot',
  moonshot: 'moonshot',
  silicon: 'siliconflow',
  siliconflow: 'siliconflow',
  siliconcloud: 'siliconflow',
  zhipu: 'bigmodel',
  zhipuai: 'bigmodel',
  bigmodel: 'bigmodel',
  glm: 'bigmodel',
  minimax: 'minimax',
  minimaxi: 'minimax',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  oneapi: 'openai',
  newapi: 'openai',
  doneapi: 'openai',
  openai: 'openai',
  opencode: 'opencode',
  opencodego: 'opencode-go',
})

/** Normalize provider names (stripping punctuation, lowering case, applying aliases). */
export function normalizeProviderKey(key: string): string {
  const clean = key.toLowerCase().replace(/[-_\s]/gu, '')
  return CANONICAL_ALIASES[clean] ?? clean
}

/** Infer canonical provider ID from a configured baseURL hostname. */
export function inferProviderFromBaseUrl(baseURL?: string): string | undefined {
  if (baseURL === undefined || baseURL === '') return undefined
  try {
    const url = new URL(baseURL)
    const host = url.hostname.toLowerCase()
    if (host.includes('deepseek.com')) return 'deepseek'
    if (host.includes('siliconflow.cn') || host.includes('siliconflow.com')) return 'siliconflow'
    if (host.includes('moonshot.cn')) return 'moonshot'
    if (host.includes('bigmodel.cn') || host.includes('z.ai')) return 'bigmodel'
    if (host.includes('minimax.io') || host.includes('minimaxi.com') || host.includes('minimax.chat')) return 'minimax'
    if (host.includes('openrouter.ai')) return 'openrouter'
    if (host.includes('opencode.ai')) return 'opencode-go'
    if (host.includes('oneapi') || host.includes('newapi') || host.includes('doneapi') || host.includes('openai.com')) return 'openai'
  } catch {
    // baseURL was not a valid URL
  }
  return undefined
}

/**
 * DeepSeek OAuth wallets for the keyless fallback: when the provider has no
 * API key but the harness holds a signed-in DeepSeek account, read its
 * recharge + bonus wallets so OAuth users still see a number.
 *
 * 契约（@deepseek-ai/dsh-deepseek-account@0.2.1-alpha.2，同 optionalDependencies）：
 * 服务名 `deepseekAccount` 由宿主挂载（Context augmentation 声明，非本包提供——
 * owner 在宿主侧，故本包只做具名消费 + 版本声明，不自建影子服务）；`getBalance`
 * 必带 `AccountClientMetadata`，返回 `{status:'ready', value, bonusWallets} |
 * {status:'failed'} | null`（null = 未登录/授权变更中，按无钱包处理）。
 *
 * 注意 dsh-agent 也必须钉在 optionalDependencies（0.2.1-alpha.2 精确版）：
 * account 包的 d.ts 经 account-tasks 引用 dsh-agent 类型，其 SessionId branding
 * 必须与本仓其余宿主包（alpha.2）同源，否则 session-archive 出现双版本
 * SessionId 类型冲突。agent 仅参与编译期，运行时从不加载。
 *
 * Amounts arrive as decimal strings; parsed per currency, unparseable entries
 * skipped. Recharge and bonus stay separate here (no summation — the querier
 * decides the window shape, mirroring the API path's per-currency rows).
 */
async function readDeepSeekAccountWallets(ctx: Context, signal: AbortSignal): Promise<{
  wallets?: AccountWalletBalance[]
  error?: string
}> {
  const account = ctx.get('deepseekAccount')
  if (account === undefined || account === null || typeof account.getBalance !== 'function') return {}
  const client: AccountClientMetadata = {
    version: 'provider-usage',
    locale: 'en',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
  let balance: Awaited<ReturnType<typeof account.getBalance>> | undefined
  try {
    balance = await account.getBalance(client)
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (signal.aborted) return {}
  if (balance === null || typeof balance !== 'object') return {}
  if (balance.status !== 'ready') return { error: 'DeepSeek account balance unavailable' }
  const parseWallets = (list: readonly AccountWallet[]): Array<{ currency: string; amount: number }> => {
    const out: Array<{ currency: string; amount: number }> = []
    for (const entry of list) {
      const currency = entry.currency as string
      if (typeof entry.currency !== 'string' || currency === '' || typeof entry.balance !== 'string') continue
      const amount = Number(entry.balance)
      if (!Number.isFinite(amount) || amount < 0) continue
      out.push({ currency, amount })
    }
    return out
  }
  const grouped = new Map<string, AccountWalletBalance>()
  for (const wallet of parseWallets(balance.value)) {
    const slot = grouped.get(wallet.currency) ?? { currency: wallet.currency, recharge: 0, bonus: 0 }
    slot.recharge += wallet.amount
    grouped.set(wallet.currency, slot)
  }
  for (const wallet of parseWallets(balance.bonusWallets)) {
    const slot = grouped.get(wallet.currency) ?? { currency: wallet.currency, recharge: 0, bonus: 0 }
    slot.bonus += wallet.amount
    grouped.set(wallet.currency, slot)
  }
  return { wallets: [...grouped.values()] }
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

    const candidates = llm.listConfigurableProviders()
    const normalized = normalizeProviderKey(provider)
    const entry = candidates.find(candidate => candidate.provider === provider)
      ?? candidates.find(candidate => normalizeProviderKey(candidate.provider) === normalized)

    let baseURL: string | undefined
    let apiKey: string | undefined
    const credentials = ctx.get('credentials')

    if (entry !== undefined) {
      // The namespace section read (`settings.get(ns)`) is gone from the
      // host: the forms service projects Loader profile entries, so the
      // section is the resolved value of the descriptor keyed by the
      // directory's settingsNs.
      const section = ctx.get('settings')?.describe().find(candidate => candidate.ns === entry.settingsNs)?.value
      const profile = profileOf(section, entry.settingsPath)
      baseURL = str(profile?.['baseURL'])
      const apiKeyEnv = str(profile?.['apiKeyEnv'])

      if (apiKeyEnv !== undefined && credentials !== undefined) {
        const resolved = await credentials.resolve(credentialRef(apiKeyEnv))
        if (signal.aborted) return baseURL === undefined ? {} : { baseURL }
        apiKey = resolved?.value
      }
    }

    // Fallback: check ambient or well-known credentials if still unresolved.
    // Deliberately only these three routes: they are the ones whose ambient
    // key names are stable public knowledge (documented by the vendors and
    // mirrored in our own profile templates). Other providers resolve keys
    // exclusively through their profile's apiKeyEnv — guessing names like
    // MOONSHOT_API_KEY would silently pick up unrelated exports.
    if (apiKey === undefined && credentials !== undefined) {
      const fallbackRefs: Record<string, string[]> = {
        'opencode': ['OPENCODE_API_KEY', 'OPENCODE_GO_API_KEY'],
        'opencode-go': ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
        'deepseek': ['DEEPSEEK_API_KEY'],
      }
      const refs = fallbackRefs[provider] ?? fallbackRefs[normalized]
      if (refs !== undefined) {
        for (const ref of refs) {
          try {
            const resolved = await credentials.resolve(credentialRef(ref))
            if (signal.aborted) return baseURL === undefined ? {} : { baseURL }
            if (resolved?.value) {
              apiKey = resolved.value
              break
            }
          } catch {}
        }
      }
    }

    // DeepSeek keyless fallback: an API key wins whenever present (a single
    // source answers, never double-counted); only keyless DeepSeek routes
    // consult the OAuth account.
    let accountWallets: AccountWalletBalance[] | undefined
    let accountError: string | undefined
    if ((apiKey === undefined || apiKey === '') && normalized === 'deepseek') {
      const read = await readDeepSeekAccountWallets(ctx, signal)
      if (signal.aborted) return { ...baseURL === undefined ? {} : { baseURL } }
      accountWallets = read.wallets
      accountError = read.error
    }

    return {
      ...baseURL === undefined ? {} : { baseURL },
      ...apiKey === undefined || apiKey === '' ? {} : { apiKey },
      ...accountWallets === undefined ? {} : { accountWallets },
      ...accountError === undefined ? {} : { accountError },
    }
  }
}
