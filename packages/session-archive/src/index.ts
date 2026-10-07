/**
 * index.ts — 插件入口：remote 网关接线、name/inject 与 apply。
 *
 * 2026-10-08 从 897 行的 src/index.ts 拆出：扫描助手、配置与 host 工厂各自成
 * 模块，入口只保留网关接线与 apply。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.ts — 插件入口：remote 网关接线与 apply
 * - archive-host.ts — 归档 host 工厂（list/count/detail/delete/unarchive）
 * - session-scan.ts — 会话文件扫描与读取助手
 * - plugin-config.ts — 插件身份与配置默认值/校验/归一化
 * - config-store.ts — 配置持久化（与 sandbox-extra-roots 同字节，根 test 锁一致）
 * - remote.ts typert-loader.ts typert.host.ts — typert 网关、惰性加载器与服务面声明
 * - session-id.ts — 网关入参的 session id 断言
 *
 * @module @chaoset/session-archive/index
 */

import type { Context } from '@deepseek-ai/cordis'
import { createConfigStore } from './config-store.js'
import { name, DEFAULT_CONFIG, config, validateConfig, normalizeConfig } from './plugin-config.js'
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
  const cfg = normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig });
  const store = createConfigStore({
    name,
    defaults: DEFAULT_CONFIG,
    patchConfig,
    validate: validateConfig,
    onUpdate: (merged) => {
      Object.assign(cfg, normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig, ...merged }));
    },
  });
  // 启动时也以 config.json（若有）为权威，和其余插件保持一致。
  Object.assign(cfg, normalizeConfig(store.effective()));

  if (SessionArchiveGateway !== null) {
    ctx.plugin(SessionArchiveGateway, { host: createArchiveHost(ctx, cfg), serviceKey: 'sessionArchive' });
  }
  return store;
}
