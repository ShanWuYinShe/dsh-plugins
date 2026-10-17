/**
 * gateway.ts — remote 配置网关的惰性加载（typert 不可用时为 null）。
 *
 * 2026-10-08 从 545 行的 src/index.ts 拆出：配置、根目录判定、landlock 解析、
 * 网关与 apply 各自成模块，入口只保留 name/inject 与 re-export。
 *
 * @module @chaoset/sandbox-extra-roots/gateway
 */



export let PluginConfigGateway: any = null;
try {
  ({ PluginConfigGateway } = await import("./remote.js"));
} catch (error) {
  // 模块求值期尚无 ctx 可用，console 是唯一日志通道（全包其余 host 日志
  // 均走 ctx.logger）。fail-safe：网关缺席时配置页降级，插件不崩。
  console.warn("sandbox-extra-roots: settings gateway unavailable: " + ((error as Error)?.message ?? String(error)));
}
