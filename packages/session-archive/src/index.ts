/**
 * index.ts — 插件入口：name/inject 与 apply。
 *
 * 2026-10-29 适配 0.2.2：远程服务改为静态 import 的标准装饰器实现（见
 * ./remote.ts），./typert 与 ./remote 工件由官方 @deepseek-ai/dsh-typert-generator
 * 生成；旧动态 import 兜底、手写 typert.host.ts 与 typert-loader.ts 已删除。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.ts — 插件入口：name/inject 与 apply
 * - archive-host-context.ts — 远程服务的内部依赖装配（deps：归档集合快照、
 *   持久化句柄、文件/事件原语）；五个能力方法本体在 remote.ts
 * - session-scan.ts — 会话文件扫描与读取助手
 * - session-query-bridge.ts — sessionQuery 可选服务的唯一探测入口（自有最小契约）
 * - session-projection-bridge.ts — 官方持久化 projection 缓存（sessionProjectionCache）
 *   的唯一探测入口：归档列表标题的零 I/O 来源（自有最小契约）
 * - plugin-config.ts — 插件身份与配置默认值/归一化
 * - config.ts — 插件配置的公开形状与 Loader 校验 schema（入口导出的 Config）
 * - types.ts — Remote 服务面的公共边界类型（typert 生成器引用）
 * - remote.ts — 归档管理 Remote 服务（标准 @Remote 装饰器）
 * - session-id.ts — 网关入参的 session id 断言
 *
 * @module @chaoset/session-archive/index
 */

import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_CONFIG, normalizeConfig } from './plugin-config.js'
import type { SessionArchiveConfig } from './plugin-config.js'
import { SessionArchiveGateway } from './remote.js'

// Cordis Loader 的 function plugin 面：只导出 name / inject / Config / apply（值导出）。
// 小写 config 导出不是 Cordis 元数据、从不被读取，2026-10-29 已删除；
// 入口面锁 test/entry-surface.test.ts 拦住它长回来。
export { name, inject } from './plugin-config.js'
export { Config } from './config.js'

/** 插件 apply：注册远程服务（面板 UI 读写）。 */
export function apply(ctx: Context, config?: Partial<SessionArchiveConfig>): void {
  // 生效配置：defaults 与 cordis 注入的 patch config（含 profile patch 里的
  // 用户 override——保存经官方 configEditor 写入,由 Loader 对账后 reload 本行
  // 使新配置在这里生效）。Loader 已按 config.ts 的 Config schema 校验过一行
  // config；normalizeConfig 是绕过 Loader 的直调/旧 profile 的最终防线，
  // 非法值经宿主 logger 告警后回退默认值（不再静默）。
  const cfg = normalizeConfig(
    { ...DEFAULT_CONFIG, ...(config ?? {}) },
    DEFAULT_CONFIG,
    (message) => ctx.logger?.warn?.(message),
  )
  // @Remote 能力方法直接由 Gateway 实现（SA-08）——只把生效配置与纯内部
  // 的 deps 装配传进去；不再构造另一个 host 转发对象。
  ctx.plugin(SessionArchiveGateway, { cfg })
}
