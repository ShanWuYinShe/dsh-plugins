/**
 * providers.ts — 内置 querier 聚合点：注册表 + 各 provider 查询器的 re-export。
 *
 * @module @chaoset/provider-usage/providers
 */

import type { ProviderUsageQuerier } from './types.js'
import { deepseekUsage } from './provider-deepseek.js'
import { openrouterUsage } from './provider-openrouter.js'
import { moonshotUsage } from './provider-moonshot.js'
import { siliconflowUsage } from './provider-siliconflow.js'
import { bigmodelUsage } from './provider-bigmodel.js'
import { minimaxUsage } from './provider-minimax.js'
import { openaiUsage } from './provider-openai.js'
import { opencodeUsage } from './provider-opencode.js'

// 对外 API：各 provider 的查询器（内置注册表见文件末尾）。
export {
  deepseekUsage,
  openrouterUsage,
  moonshotUsage,
  siliconflowUsage,
  bigmodelUsage,
  minimaxUsage,
  openaiUsage,
  opencodeUsage,
}

/**
 * Every built-in querier, keyed by provider route.
 *
 * Registering these is opt-out by omission: a deployment that wants different
 * behaviour for one of these routes registers its own querier afterwards and
 * wins, because a later registration replaces an earlier one.
 *
 * WorkBuddy's two routes are deliberately absent: this package has no way to
 * read that desktop app's credential, and the plugin that owns those routes
 * (`@chaoset/dsh-any-connect`) registers its own querier against the billing
 * endpoint it already talks to. That is the intended shape — the provider's
 * owner is the right place to know its billing API.
 *
 * 2026-10-19 补官方 DeepSeek 的两条路由键（该形状自宿主 0.2.1-rc.2 延续至今）：
 * `deepseek-account`（OAuth 钱包，profile 段里没有 apiKeyEnv）与
 * `deepseek-official`（API key，apiKeyEnv 默认 `DEEPSEEK_API_KEY`）两条，
 * **宿主并不存在 `deepseek` 路由**——保留该键只为兼容沿用它的自定义 profile。
 * 三条都指向同一个 deepseekUsage：查询器按「有 apiKey 走 /user/balance、
 * 无 key 走 OAuth 钱包」分流，与路由键无关；两条官方键另由 resolve 的别名表
 * 归一到 canonical `deepseek`，从而拿到 DEEPSEEK_API_KEY 兜底与钱包回退。
 */
export const BUILTIN_USAGE_QUERIERS: ReadonlyMap<string, { querier: ProviderUsageQuerier; displayName: string }> = new Map([
  ['deepseek', { querier: deepseekUsage, displayName: 'DeepSeek' }],
  ['deepseek-account', { querier: deepseekUsage, displayName: 'DeepSeek' }],
  ['deepseek-official', { querier: deepseekUsage, displayName: 'DeepSeek' }],
  ['openrouter', { querier: openrouterUsage, displayName: 'OpenRouter' }],
  ['moonshot', { querier: moonshotUsage, displayName: 'Moonshot' }],
  ['siliconflow', { querier: siliconflowUsage, displayName: 'SiliconFlow' }],
  ['bigmodel', { querier: bigmodelUsage, displayName: 'BigModel' }],
  ['minimax', { querier: minimaxUsage, displayName: 'MiniMax' }],
  ['openai', { querier: openaiUsage, displayName: 'OpenAI / OneAPI' }],
  ['opencode', { querier: opencodeUsage, displayName: 'OpenCode' }],
  ['opencode-go', { querier: opencodeUsage, displayName: 'OpenCode Go' }],
])
