/**
 * plugin-config.ts — 插件身份（name/inject）与配置默认值。
 *
 * @module @chaoset/sandbox-extra-roots/plugin-config
 */

import type { SandboxExtraRootsConfig } from './types.js';

export const name = "sandbox-extra-roots";

export const inject = ["sandbox", "fs", "sandboxPolicy"];

/**
 * 默认配置。apply 时与 YAML 传入的 config 合并。
 *
 * 不要从插件入口导出小写 `config`：Cordis 的插件元数据只认大写 `Config`
 * schema，entry 的 config 来自 profile patch，小写导出从不被读取（2026-10-29
 * 清除遗留死导出；入口面锁 test/entry-surface.test.ts 会拦住它长回来）。
 */
export const DEFAULT_CONFIG: SandboxExtraRootsConfig = {
  extraWritableRoots: []
};
