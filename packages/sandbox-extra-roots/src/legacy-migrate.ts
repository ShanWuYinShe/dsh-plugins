/**
 * legacy-migrate.ts — 旧版 config.json（0.4.x 自建目录）一次性迁移进
 * profile patch。写入成功才把旧文件改名 *.imported；config-editor 不可用
 * 时保留旧文件，下次启动重试。
 *
 * @module sandbox-extra-roots/legacy-migrate
 */

import { DEFAULT_CONFIG } from "./plugin-config.js";
import { markLegacyImported, readLegacyConfig, resolveConfigPersist } from "./config-store.js";

/**
 * 把旧版配置并入官方通道。合并基必须是 edit 回调收到的 current（Loader
 * 侧当前值），而不是 apply 时刻的 patchConfig 快照——否则 apply 与迁移
 * 完成之间发生的行 reload（用户的新编辑）会被旧快照覆盖。
 */
export async function migrateLegacyConfig(name: string, ctx: any): Promise<void> {
  const legacy = readLegacyConfig(name);
  if (legacy === undefined) return;
  const persist = resolveConfigPersist(ctx);
  if (persist === undefined) {
    ctx.logger?.warn?.(`${name}: config-editor unavailable; legacy config.json kept for a later migration`);
    return;
  }
  try {
    await persist.edit((current) => ({ ...DEFAULT_CONFIG, ...current, ...legacy }));
    markLegacyImported(name);
  } catch (error) {
    ctx.logger?.warn?.(`${name}: legacy config migration failed (${(error as Error)?.message ?? String(error)}); will retry on next start`);
  }
}
