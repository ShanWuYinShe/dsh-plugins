/**
 * index.ts — 插件入口：name/inject 与 re-export。
 *
 * 2026-10-08 从 545 行的 src/index.ts 拆出：配置、根目录判定、landlock 解析、
 * 网关与 apply 各自成模块，入口只保留 name/inject 与 re-export。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.ts — 插件入口：name/inject 与 re-export
 * - apply.ts — 插件主体：sandbox/fs 包装装配（runner 改写见 confine-runners）
 * - confine-runners.ts — confine 按 runner 改写 + 运行期危险根复查（纯函数）
 * - legacy-migrate.ts — 旧版 config.json 一次性迁移（以 Loader current 为基）
 * - roots-filter.ts config-validate.ts — 真实存在目录过滤（带 TTL 缓存）与配置校验/规范化
 * - roots.ts — 额外根目录规范化、分类与授予集合
 * - plugin-config.ts — 插件身份与配置默认值/生效配置
 * - common.ts — 沙盒能力探测与宿主路径工具
 * - landlock-exec.ts gateway.ts — landlock 可执行解析缓存、remote 网关惰性加载
 * - config-store.ts remote.ts typert-loader.ts typert.host.ts — typert 配置网关
 *   （config-store 与 typert-loader 和 session-archive 同字节，根 test 锁一致）
 *
 * @module @chaoset/sandbox-extra-roots/index
 */

export { name, inject, config } from './plugin-config.js'
export { apply } from './apply.js'
