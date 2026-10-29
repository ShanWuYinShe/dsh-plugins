/**
 * index.ts — 插件入口：name/inject 与 apply。
 *
 * 2026-10-08 从 897 行的 src/index.ts 拆出：扫描助手、配置与 host 工厂各自成
 * 模块，入口只保留网关接线与 apply。
 *
 * 2026-10-29 适配 0.2.2：远程服务改为静态 import 的标准装饰器实现（见
 * ./remote.ts），./typert 与 ./remote 工件由官方 @deepseek-ai/dsh-typert-generator
 * 生成；旧动态 import 兜底、手写 typert.host.ts 与 typert-loader.ts 已删除。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.ts — 插件入口：name/inject 与 apply
 * - archive-host.ts archive-host-context.ts archive-host-queries.ts archive-host-mutations.ts —
 *   归档 host 组合入口、内部上下文（deps 对象）与只读查询 / 写操作两个子工厂
 * - session-scan.ts — 会话文件扫描与读取助手
 * - session-query-bridge.ts — sessionQuery 可选服务的唯一探测入口（自有最小契约）
 * - plugin-config.ts — 插件身份与配置默认值/校验/归一化
 * - types.ts — Remote 服务面的公共边界类型（typert 生成器引用）
 * - remote.ts — 归档管理 Remote 服务（标准 @Remote 装饰器）
 * - session-id.ts — 网关入参的 session id 断言
 *
 * @module @chaoset/session-archive/index
 */

import type { Context } from '@deepseek-ai/cordis'
import { name, DEFAULT_CONFIG, normalizeConfig } from './plugin-config.js'
import { createArchiveHost } from './archive-host.js'
import { SessionArchiveGateway } from './remote.js'

// Cordis Loader 的 function plugin 面：只导出 name / inject / apply（值导出）。
// 小写 config 导出不是 Cordis 元数据、从不被读取，2026-10-29 已删除；
// 入口面锁 test/entry-surface.test.ts 拦住它长回来。
export { name, inject } from './plugin-config.js'

/** 插件 apply：注册远程服务（面板 UI 读写）。 */
export function apply(ctx: Context, config?: any): any {
  const patchConfig = config || {};
  // 生效配置：defaults 与 cordis 注入的 patch config（含 profile patch 里的
  // 用户 override——保存经官方 configEditor 写入,由 Loader 对账后 reload 本行
  // 使新配置在这里生效）。
  const cfg = normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig });
  ctx.plugin(SessionArchiveGateway as any, { host: createArchiveHost(ctx, cfg) });
}
