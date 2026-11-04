/**
 * index.ts — 插件入口：name/inject 与 re-export。
 *
 * 2026-10-08 从 545 行的 src/index.ts 拆出：配置、根目录判定、landlock 解析、
 * 网关与 apply 各自成模块，入口只保留 name/inject 与 re-export。
 *
 * enforcement 自 0.4.31 起收敛到官方 sandbox policy：本包不再包装 confine/fs
 * 私有面，只把配置的额外根并入 `sandboxPolicy.additionalWritableRoots`。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.ts — 插件入口：name/inject 与 re-export
 * - apply.ts — 插件主体：配置解析、policy 包装装配与 Remote 服务注册（含降级）
 * - policy-merge.ts — 包装官方 ctx.sandboxPolicy.resolve()，把生效根并入 additionalWritableRoots（引用计数/还原）
 * - roots-filter.ts config-validate.ts — 实例级目录存在性过滤（工厂）与配置校验/规范化
 * - roots.ts — 额外根目录 canonical 化与风险分类（reject/filter）
 * - config.ts — 插件配置 schema（Loader 读取的 Config 导出）
 * - plugin-config.ts — 插件身份（name/inject）与配置默认值
 * - types.ts — Remote 服务面的公共边界类型（typert 生成器引用）
 * - config-store.ts remote.ts — 官方 configEditor 持久化适配与 Remote 服务
 *
 * typert 工件（./typert Host 面与 ./remote Client 面）由官方
 * @deepseek-ai/dsh-typert-generator 从 src/remote.ts 的装饰器与方法类型生成，
 * 不再手写。
 *
 * @module @chaoset/sandbox-extra-roots/index
 */

// Cordis Loader 的 function plugin 面：只导出 name / inject / Config / apply（值导出）。
// 小写 config 导出不是 Cordis 元数据、从不被读取，2026-10-29 已删除；
// 入口面锁 test/entry-surface.test.ts 拦住它长回来。
export { name, inject } from './plugin-config.js'
export { apply } from './apply.js'
// 配置 schema：Loader 激活 entry 时用它校验/补默认值（RULE-060）。
export { Config } from './config.js'
