/**
 * config-store.ts — 官方 configEditor 持久化适配。
 *
 * 配置持久化只走官方途径：设置页保存经 ctx.configEditor.edit() 写入当前
 * profile 的 cordis.patch.yml 本行 config（与 Web 设置编辑器同一途径，
 * dsh-base 内置该服务），由 Loader 对账生效；本文件不读写任何自建配置文件
 * （旧版 $DSH_HOME/plugins/<name>/config.json 迁移已随 0.2.2 适配删除）。
 *
 * 本文件在 sandbox-extra-roots 与 session-archive 两包里必须逐字相同：两包
 * 刻意零运行时依赖、可独立安装，这份机制无法提为共享 npm 包，只能各持一份，
 * 靠根 `test/bundle.test.ts` 的一致性锁逐字比较防漂移——改一侧必须改另一侧。
 */

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
