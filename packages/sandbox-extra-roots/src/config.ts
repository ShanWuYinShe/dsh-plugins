/**
 * config.ts — 插件配置 schema（Cordis Loader 读取的 `Config` 导出）。
 *
 * function plugin 的配置约定（官方 docs/defensive-patterns/package-surface.md）：
 * 入口同时导出 `interface Config`（类型面）与同名 schema 值（运行期校验面）。
 * Loader 在激活 entry 时用 schema 校验 profile patch 里的本行 config，默认值
 * 由 schema 补齐——因此这里的默认值必须与 cordis.patch.yml 的默认一致。
 *
 * 未知字段策略（已对 rc.1 schemastery 3.19 实测）：schema 校验**保留**未声明的
 * 字段（不拒绝、也不剥离）。因此本包不依赖 schema 治理未知字段——写入侧在
 * remote.ts 用白名单只并入 extraWritableRoots，读取侧 normalizeRoots 只消费
 * 该字段，旧版本残留字段不会影响生效配置，也不会在一次保存后被误删。
 * 注意 apply 仍用 normalizeRoots 做最终防线（canonical 化/危险根过滤）：schema
 * 只保证形状与默认值，路径安全语义在配置生效处统一执行。
 *
 * @module @chaoset/sandbox-extra-roots/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * 插件配置（与 Remote wire 面 types.ts 的 SandboxExtraRootsConfig 同形）。
 * 所有字段都有 schema 默认值：Loader 传入的 config 是补齐后的完整形状。
 */
export interface Config {
  /** workspace-write 模式下额外允许写入的目录（绝对路径；生效前 canonical 化、去重并过滤危险根）。 */
  extraWritableRoots: string[]
}

/** Loader 校验用 schema：默认值与 cordis.patch.yml 的 `config` 一致。 */
export const Config = z.object({
  extraWritableRoots: z.array(z.string()).default([]),
})
