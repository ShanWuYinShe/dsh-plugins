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
 * - roots-filter.ts config-validate.ts — 真实存在目录过滤（带 TTL 缓存）与配置校验/规范化
 * - roots.ts — 额外根目录规范化、分类与授予集合
 * - plugin-config.ts — 插件身份（name/inject）与配置默认值
 * - common.ts — 沙盒能力探测与宿主路径工具（官方 dsh-sandbox 静态导入）
 * - landlock-exec.ts — 官方 landlock-run 启动器解析缓存（仅 Linux）
 * - types.ts — Remote 服务面的公共边界类型（typert 生成器引用）
 * - config-store.ts remote.ts — 官方 configEditor 持久化适配与 Remote 服务
 *   （config-store 与 session-archive 逐字一致，根 test 锁一致）
 *
 * typert 工件（./typert Host 面与 ./remote Client 面）由官方
 * @deepseek-ai/dsh-typert-generator 从 src/remote.ts 的装饰器与方法类型生成，
 * 不再手写。
 *
 * @module @chaoset/sandbox-extra-roots/index
 */

// Cordis Loader 的 function plugin 面：只导出 name / inject / apply（值导出）。
// 小写 config 导出不是 Cordis 元数据、从不被读取，2026-10-29 已删除；
// 入口面锁 test/entry-surface.test.ts 拦住它长回来。
export { name, inject } from './plugin-config.js'
export { apply } from './apply.js'
