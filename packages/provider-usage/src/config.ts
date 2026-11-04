/**
 * config.ts — 插件配置：查询 deadline 与缓存/负缓存 TTL。
 *
 * 这几项是**部署相关可变量**（账单接口慢时把 deadline 调大、自建代理想加长
 * 缓存、限流严重时缩短成功缓存），因此进 Config 由 Loader 校验、用户可在
 * cordis.patch.yml 的 config 里覆盖；默认值等于既有常量，行为与改造前一致。
 * 客户端 resource 流的 60s 轮询不在配置面内：它是浏览器协议节拍（与宿主成功
 * 缓存同量级，见 client/resource-provider.ts），不是部署差异。
 *
 * @module provider-usage/config
 */

import z from '@deepseek-ai/schemastery'

/** 单次查询（含端点/凭据解析）的 deadline 默认值。 */
export const DEFAULT_QUERY_TIMEOUT_MS = 15_000

/** 成功答案的缓存时长默认值。 */
export const DEFAULT_CACHE_TTL_MS = 60_000

/** 失败答案的负缓存时长默认值：错误没有成功答案的保质期，按更短负缓存处理。 */
export const DEFAULT_ERROR_CACHE_TTL_MS = 10_000

/** 无推断结果（`snapshot` 为 undefined）的负缓存时长默认值。 */
export const DEFAULT_UNRESOLVED_TTL_MS = 60_000

/** `setTimeout` 可接受的最大延时（2^31-1ms）：更长的 deadline 会被 Node 当成 1ms 立即触发。 */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * 插件配置：全部字段有默认值，缺省即用 schema 的默认。
 *
 * 字段名与 registry 的构造选项同名，apply 解析后原样传给
 * {@link ProviderUsageRegistry}（见 src/index.ts），两侧不会漂移。
 */
export interface Config {
  /** 单次查询（含端点/凭据解析）的 deadline（毫秒）。默认 15000。 */
  queryTimeoutMs?: number
  /** 成功答案的缓存时长（毫秒）。默认 60000。 */
  cacheTtlMs?: number
  /** 失败答案的负缓存时长（毫秒），比成功 TTL 短，恢复后第一次读取即重试。默认 10000。 */
  errorCacheTtlMs?: number
  /** 推断无果的负缓存时长（毫秒）。默认 60000。 */
  unresolvedTtlMs?: number
}

/**
 * 配置 schema：Loader 用它在插件激活时校验并补齐默认值。
 *
 * 未知字段会被 schemastery 剥离（陈旧配置不报错，与 dsh-any-connect 同口径）。
 */
export const Config: z<Config> = z.object({
  queryTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_QUERY_TIMEOUT_MS),
  cacheTtlMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CACHE_TTL_MS),
  errorCacheTtlMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_ERROR_CACHE_TTL_MS),
  unresolvedTtlMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_UNRESOLVED_TTL_MS),
})

/** 解析后的配置：四个字段都必有值。 */
export interface ResolvedConfig {
  queryTimeoutMs: number
  cacheTtlMs: number
  errorCacheTtlMs: number
  unresolvedTtlMs: number
}

/**
 * 校验配置并补齐默认值。
 *
 * Loader 已按 {@link Config} 校验过一次；直接调用 `apply()` 的 caller（测试、
 * 手工装载）也走同一口径，避免绕过 schema 的负值/NaN 进入 registry。
 *
 * @param config - 原始配置，缺省为 `{}`（全默认）。
 * @returns 四个字段都已解析的配置。
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return Config(config) as ResolvedConfig
}
