/**
 * providers.ts — 内置 querier 聚合点：注册表 + 各 provider 的 re-export。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
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
 */
export const BUILTIN_USAGE_QUERIERS: ReadonlyMap<string, { querier: ProviderUsageQuerier; displayName: string }> = new Map([
  ['deepseek', { querier: deepseekUsage, displayName: 'DeepSeek' }],
  ['openrouter', { querier: openrouterUsage, displayName: 'OpenRouter' }],
  ['moonshot', { querier: moonshotUsage, displayName: 'Moonshot' }],
  ['siliconflow', { querier: siliconflowUsage, displayName: 'SiliconFlow' }],
  ['bigmodel', { querier: bigmodelUsage, displayName: 'BigModel' }],
  ['minimax', { querier: minimaxUsage, displayName: 'MiniMax' }],
  ['openai', { querier: openaiUsage, displayName: 'OpenAI / OneAPI' }],
  ['opencode', { querier: opencodeUsage, displayName: 'OpenCode' }],
  ['opencode-go', { querier: opencodeUsage, displayName: 'OpenCode Go' }],
])
