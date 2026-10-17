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

/** 默认配置。apply 时与 YAML 传入的 config 合并(cordis 不合并小写 config 导出)。 */
export const DEFAULT_CONFIG = {
  extraWritableRoots: []
};

export const config = { ...DEFAULT_CONFIG };
