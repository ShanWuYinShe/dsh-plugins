/**
 * index.ts — 插件入口：remote 网关接线、name/inject 与 apply。
 *
 * 2026-10-08 从 897 行的 src/index.ts 拆出：扫描助手、配置与 host 工厂各自成
 * 模块，入口只保留网关接线与 apply。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.ts — 插件入口：remote 网关接线与 apply
 * - archive-host.ts archive-host-context.ts archive-host-queries.ts archive-host-mutations.ts —
 *   归档 host 组合入口、内部上下文（deps 对象）与只读查询 / 写操作两个子工厂
 * - session-scan.ts — 会话文件扫描与读取助手
 * - plugin-config.ts — 插件身份与配置默认值/校验/归一化
 * - config-store.ts — 配置持久化（与 sandbox-extra-roots 同字节，根 test 锁一致）
 * - remote.ts typert-loader.ts typert.host.ts — typert 网关、惰性加载器与服务面声明
 * - session-id.ts — 网关入参的 session id 断言
 *
 * @module @chaoset/session-archive/index
 */

import type { Context } from '@deepseek-ai/cordis'
import { markLegacyImported, readLegacyConfig, resolveConfigPersist } from './config-store.js'
import { name, DEFAULT_CONFIG, normalizeConfig } from './plugin-config.js'
import { createArchiveHost } from './archive-host.js'

export { name, inject, config } from './plugin-config.js'
export { createArchiveHost } from './archive-host.js'

let SessionArchiveGateway: any = null;
try {
  ({ SessionArchiveGateway } = await import('./remote.js'));
} catch (error) {
  console.warn('session-archive: remote gateway unavailable: ' + ((error as Error)?.message ?? String(error)));
}

/** 插件 apply：注册远程服务（面板 UI 读写）。 */
export function apply(ctx: Context, config?: any): any {
  const patchConfig = config || {};
  // 生效配置：defaults 与 cordis 注入的 patch config（含 profile patch 里的
  // 用户 override——保存经官方 configEditor 写入,由 Loader 对账后 reload 本行
  // 使新配置在这里生效）。
  const cfg = normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig });

  // 旧版 config.json（0.3.x 自建目录）一次性迁移进 profile patch;后台执行,
  // 不阻塞激活。写入成功才把旧文件改名 *.imported;config-editor 不可用时
  // 保留旧文件,下次启动重试。
  void (async () => {
    const legacy = readLegacyConfig(name);
    if (legacy === undefined) return;
    const persist = resolveConfigPersist(ctx);
    if (persist === undefined) {
      ctx.logger?.warn?.('session-archive: config-editor unavailable; legacy config.json kept for a later migration');
      return;
    }
    try {
      await persist.edit(() => normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig, ...legacy }));
      markLegacyImported(name);
    } catch (error) {
      ctx.logger?.warn?.(`session-archive: legacy config migration failed (${(error as Error)?.message ?? String(error)}); will retry on next start`);
    }
  })();

  if (SessionArchiveGateway !== null) {
    ctx.plugin(SessionArchiveGateway, { host: createArchiveHost(ctx, cfg), serviceKey: 'sessionArchive' });
  }
}
