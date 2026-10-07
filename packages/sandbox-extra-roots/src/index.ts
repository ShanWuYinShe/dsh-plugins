/**
 * index.ts — 插件入口：name/inject 与 re-export。
 *
 * 2026-10-08 从 545 行的 src/index.ts 拆出：配置、根目录判定、landlock 解析、
 * 网关与 apply 各自成模块，入口只保留 name/inject 与 re-export。
 *
 * @module @chaoset/sandbox-extra-roots/index
 */

export { name, inject, config } from './plugin-config.js'
export { apply } from './apply.js'
