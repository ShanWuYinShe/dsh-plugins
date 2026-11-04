/**
 * plugin-config.ts — 插件身份（name/inject）、配置默认值与归一化。
 *
 * @module @chaoset/session-archive/plugin-config
 */

export const name = 'session-archive';

/** sessions 参与 inject：删除前必须能查询 live 会话（存在即拒绝删除）。 */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions'];

/** 插件的生效配置（归一化后的最终形状；字段均为正整数）。 */
export interface SessionArchiveConfig {
  /** detail() 返回的最大消息条数（超出仅计数）。 */
  detailMaxMessages: number;
  /** 每条消息预览的最大字符数（超出截断加省略号）。 */
  messagePreviewChars: number;
  /** list() 时并发读取标题的最大并行数。 */
  titleReadConcurrency: number;
}

/**
 * 默认配置。apply 时与 YAML 传入的 config 合并。
 *
 * 不要从插件入口导出小写 `config`：Cordis 的插件元数据只认大写 `Config`
 * schema，entry 的 config 来自 profile patch，小写导出从不被读取（2026-10-29
 * 清除遗留死导出；入口面锁 test/entry-surface.test.ts 会拦住它长回来）。
 */
export const DEFAULT_CONFIG: SessionArchiveConfig = {
  detailMaxMessages: 200,
  messagePreviewChars: 2000,
  titleReadConcurrency: 4,
};

/** 配置归一化：非法/缺失数值回退默认值，保证运行时不会拿到 NaN/负数。 */
export function normalizeConfig(
  source: unknown,
  defaults: SessionArchiveConfig = DEFAULT_CONFIG,
): SessionArchiveConfig {
  const raw = source !== null && typeof source === 'object' && !Array.isArray(source)
    ? source as Partial<Record<keyof SessionArchiveConfig, unknown>>
    : {};
  const positiveInt = (value: unknown, fallback: number): number =>
    Number.isInteger(value) && (value as number) > 0 ? value as number : fallback;
  return {
    detailMaxMessages: positiveInt(raw.detailMaxMessages ?? defaults.detailMaxMessages, defaults.detailMaxMessages),
    messagePreviewChars: positiveInt(raw.messagePreviewChars ?? defaults.messagePreviewChars, defaults.messagePreviewChars),
    titleReadConcurrency: positiveInt(raw.titleReadConcurrency ?? defaults.titleReadConcurrency, defaults.titleReadConcurrency),
  };
}
