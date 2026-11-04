/**
 * 插件身份与配置默认值。
 *
 * inject 只剩官方 policy 服务：enforcement 已收敛到
 * `sandboxPolicy.additionalWritableRoots`（见 policy-merge.ts），不再需要
 * `sandbox`（confine 包装）/ `fs`（fs fence 包装）——那两个私有面随 SB-01
 * 收敛删除。缺 sandboxPolicy 时 apply 显式降级（Remote get 返回 degraded）。
 *
 * @module @chaoset/sandbox-extra-roots/plugin-config
 */

import type { SandboxExtraRootsConfig } from './types.js';

export const name = "sandbox-extra-roots";

export const inject = ["sandboxPolicy"];

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
