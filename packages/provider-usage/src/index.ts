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
 * 入口只保留 function plugin 的 Loader 面（name / inject / apply）；实现模块
 * 的类型与值由包内相对路径导入，外部消费者经 `ctx.providerUsage` 服务面
 * （registry.ts 的 Context augmentation）使用本包，不从入口转出。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.ts — 插件入口：注册内置 querier 与宿主路由
 * - providers.ts — 内置 querier 聚合点（注册表 + re-export）
 * - provider-shared.ts — querier 共用的取值助手与 JSON 请求
 * - provider-deepseek.ts provider-openrouter.ts provider-moonshot.ts provider-siliconflow.ts
 *   provider-bigmodel.ts provider-minimax.ts provider-openai.ts provider-opencode.ts — 各 provider 查询器
 * - registry.ts resolve.ts route.ts — 查询器注册表与缓存、端点/凭据解析、同源路由
 * - command.ts — /usage 斜杠命令（宿主 handler 直接返回额度文本报告）
 * - types.ts — 宿主与浏览器共享的类型（额度窗口、快照、注入面契约）
 *
 * @module provider-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerUsageCommand } from './command.js'
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

/**
 * Mount the registry, its resolver, the built-in queriers, the usage route,
 * and the /usage command.
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
  registerUsageCommand(ctx, registry)
}
