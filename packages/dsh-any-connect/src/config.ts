/**
 * config.ts — 插件配置：settings 命名空间、Options 形态与 schema。
 *
 * 2026-10-08 从 index.ts 提出：命名空间常量与 schema 被入口、变体助手与测试
 * 共同引用；单独成模块后 variant-runtime / runtime 都能安全依赖它，不产生环。
 *
 * @module dsh-any-connect/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/**
 * Fallback settings namespace owning the configuration card.
 *
 * The directory entry's `settingsNs` is the Loader profile entry id
 * (`ctx.fiber.entry?.options.id`); these constants only survive as the
 * fallback when no Loader hosts the plugin (bare-`Context` tests) plus the
 * stable provider-identity strings the client and tests already key on.
 */
export const WORKBUDDY_SETTINGS_NS = 'anyconnect' as SettingsNamespace

/** Fallback settings namespace owning the international variant's card. */
export const WORKBUDDY_AI_SETTINGS_NS = 'anyconnect-ai' as SettingsNamespace

/** Fallback settings namespace owning the ZCode variant's card. */
export const ZCODE_SETTINGS_NS = 'anyconnect-zcode' as SettingsNamespace

/** Plugin configuration: live volatile references committed by the Loader.
 *
 * Editable fields are declared `.volatile()` and read with `.get()`, which
 * tracks profile edits without a remount (see `loader/volatile-update`
 * below, mirroring upstream `dsh-llm-pi-ai`). The `Options` type is the
 * plain-value shape callers pass to `ctx.plugin()`; Cordis parses it through
 * this schema into the `Config` references.
 */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile: Volatile<string | undefined>
  /** Explicit WorkBuddy AI desktop auth-file path, overriding env and platform defaults. */
  authFileAI: Volatile<string | undefined>
  /** Explicit ZCode desktop auth-file path, overriding env and platform defaults. */
  authFileZCode: Volatile<string | undefined>
  // schemastery strips unknown fields, so a stale field in a
  // cordis.patch.yml is ignored rather than rejected.
}

/** Plain configuration values, before schema parsing wraps them in references. */
export type Options = {
  [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never
}

export const Config = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)').volatile(),
  authFileAI: z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)').volatile(),
  authFileZCode: z.string().description('ZCode desktop auth file (defaults to the app\'s own location)').volatile(),
})
