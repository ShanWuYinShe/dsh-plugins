/**
 * config.ts — 插件配置：Options 形态与 schema。
 *
 * 2026-10-08 从 index.ts 提出：schema 被入口、变体助手与测试共同引用；单独成
 * 模块后 variant-runtime / runtime 都能安全依赖它，不产生环。
 *
 * @module dsh-any-connect/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin configuration: live volatile references committed by the Loader.
 *
 * Editable fields are declared `.volatile()` and read with `.get()`, which
 * tracks profile edits without a remount (see `loader/volatile-update`
 * below, mirroring upstream `dsh-llm-pi-ai`). The `Options` type is the
 * plain-value shape callers pass to `ctx.plugin()`; Cordis parses it through
 * this schema into the `Config` references.
 *
 * 六个字段全部带 `.default('')`：schema/接口/实际语义三者一致——「未设置」
 * 在运行时就是空串，由各字段的消费方当「走平台默认/环境变量」处理，而不是
 * 靠某个字段恰好缺席（`?.`）来暗示可选性。
 */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile: Volatile<string | undefined>
  /** Explicit WorkBuddy AI desktop auth-file path, overriding env and platform defaults. */
  authFileAI: Volatile<string | undefined>
  /** Explicit ZCode desktop auth-file path, overriding env and platform defaults. */
  authFileZCode: Volatile<string | undefined>
  /** Explicit OpenCode desktop auth-file / token path, overriding env and platform defaults. */
  authFileOpenCode: Volatile<string | undefined>
  /**
   * 显式指定 ZCode 桌面客户端内置 provider 配置
   * （`zcode-builtin.json`，Coding Plan 模型白名单）的路径；空串 = 走
   * `ZCODE_BUILTIN_CONFIG` 环境变量与平台候选路径。部署相关路径必须是
   * Config 字段（RULE-059）：env 不会随 patch/profile 迁移保留。
   */
  zcodeBuiltinConfig: Volatile<string | undefined>
  /**
   * 显式指定 OpenCode 官方模型元数据本地缓存（`models.json`）的路径；空串 =
   * 走 `OPENCODE_MODELS_CACHE` 环境变量与 XDG 缓存默认位置。
   */
  openCodeModelsCache: Volatile<string | undefined>
  // schemastery strips unknown fields, so a stale field in a
  // cordis.patch.yml is ignored rather than rejected.
}

/** Plain configuration values, before schema parsing wraps them in references.
 *
 * 键级可选性由 `Partial` 统一表达：调用方传部分字段（其余走 schema 默认 `''`），
 * 而不是在每个字段上各写一个 `?` 来暗示「字段可能整个不存在」。
 */
export type Options = Partial<{
  [K in keyof Config]: Config[K] extends Volatile<infer T> ? T : never
}>

export const Config = z.object({
  authFile: z.string().default('').description('WorkBuddy desktop auth file (defaults to the app\'s own location)').volatile(),
  authFileAI: z.string().default('').description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)').volatile(),
  authFileZCode: z.string().default('').description('ZCode desktop auth file (defaults to the app\'s own location)').volatile(),
  authFileOpenCode: z.string().default('').description('OpenCode auth / token (defaults to public free tier)').volatile(),
  zcodeBuiltinConfig: z.string().default('').description('ZCode built-in model whitelist (zcode-builtin.json); defaults to env and platform paths').volatile(),
  openCodeModelsCache: z.string().default('').description('OpenCode model metadata cache (models.json); defaults to env and XDG cache').volatile(),
})

