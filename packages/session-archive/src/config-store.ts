/**
 * config-store.ts — 官方 configEditor 持久化适配 + 旧版 config.json 的一次性迁移。
 *
 * 0.4.x 及之前配置持久化在 $DSH_HOME/plugins/<name>/config.json——那是自创
 * 目录，harness 官方目录布局（dsh-home-paths）并不存在它，被当作插件目录
 * 清理时会连带丢配置。现改走官方途径：设置页保存经 ctx.configEditor.edit()
 * 写入当前 profile 的 cordis.patch.yml 本行 config（与 Web 设置编辑器同一
 * 途径，dsh-base 内置该服务），由 Loader 对账生效；本文件不再读写任何自建
 * 配置文件。
 *
 * 旧文件迁移：apply 时检测到旧 config.json 则把其值并入本行 patch config
 * 一次性写入，然后把旧文件改名 *.imported（官方 settings.yaml →
 * settings.yaml.imported 的同款模式），旧位置从此不再读取。
 *
 * 本文件在 sandbox-extra-roots 与 session-archive 两包里**必须逐字相同**：
 * 两包刻意零运行时依赖、可独立安装，这份机制无法提为共享 npm 包，只能各持
 * 一份，靠根 `test/bundle.test.ts` 的「共享实现一致性」锁逐字比较来防漂移
 * ——改任意一侧都会红灯，请同时改另一侧。
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/** 官方持久化通道：edit(change) 编辑本行 config，由 Loader 对账后生效。 */
export interface ConfigPersist {
  edit(change: (current: Record<string, any>) => Record<string, any>): Promise<void>;
}

/**
 * 从插件 ctx 解析官方持久化通道。profile 部署下必然可用；返回 undefined
 * 表示当前部署没有本行 entry 或 config-editor 服务（调用方应放弃持久化，
 * 不要静默自建存储）。ctx 为 cordis 上下文，字段均按运行时形态宽容访问。
 */
export function resolveConfigPersist(ctx: any): ConfigPersist | undefined {
  const entry = ctx?.fiber?.entry;
  if (entry === undefined) return undefined;
  let editor: any;
  try {
    editor = ctx.get("configEditor");
  } catch {
    return undefined;
  }
  if (editor === undefined || editor === null) return undefined;
  return { edit: (change) => editor.edit(entry, change) };
}

/** 旧版配置文件路径：$DSH_HOME/plugins/<name>/config.json（只服务于迁移）。DSH_HOME 回退与本包外两处同形（sandbox 的 common.ts dshHome、typert-loader.ts 内两处），三处刻意各持一份，改一处时同步另两处。 */
export function legacyConfigPath(name: string): string {
  const dshHome = process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
  return join(dshHome, "plugins", name, "config.json");
}

/**
 * 读取旧版配置值。文件不存在或内容损坏（非 JSON 对象）返回 undefined；
 * 迁移调用方对 undefined 直接跳过。
 */
export function readLegacyConfig(name: string): Record<string, any> | undefined {
  const file = legacyConfigPath(name);
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return undefined;
}

/** 迁移写入成功后把旧文件改名 *.imported，保留现场且不再参与读取。目标已存在时加序号后缀（*.imported.1…），旧备份永不静默覆盖。 */
export function markLegacyImported(name: string): void {
  const file = legacyConfigPath(name);
  try {
    if (!existsSync(file)) return;
    let target = `${file}.imported`;
    for (let index = 1; existsSync(target); index++) target = `${file}.imported.${index}`;
    renameSync(file, target);
  } catch {}
}
