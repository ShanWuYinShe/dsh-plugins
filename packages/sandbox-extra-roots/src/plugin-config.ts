/**
 * plugin-config.ts — 插件身份（name/inject）与配置默认值、生效配置对象。
 *
 * 2026-10-08 从 545 行的 src/index.ts 拆出：配置、根目录判定、landlock 解析、
 * 网关与 apply 各自成模块，入口只保留 name/inject 与 re-export。
 *
 * @module @chaoset/sandbox-extra-roots/plugin-config
 */



export const name = "sandbox-extra-roots";

export const inject = ["sandbox", "fs", "sandboxPolicy"];

/**
 * 默认配置。apply 时与 YAML 传入的 config 合并。
 *
 * 不要从插件入口导出小写 `config`：Cordis 的插件元数据只认大写 `Config`
 * schema，entry 的 config 来自 profile patch，小写导出从不被读取（2026-10-29
 * 清除遗留死导出；入口面锁 test/entry-surface.test.ts 会拦住它长回来）。
 */
export const DEFAULT_CONFIG = {
  extraWritableRoots: []
};
