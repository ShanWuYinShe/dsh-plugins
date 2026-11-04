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

/** 配置归一化：非法/缺失数值回退默认值，保证运行时不会拿到 NaN/负数。
 * 这是 Loader schema（config.ts 的 Config）之外的最终防线：schema 校验挡在
 * 激活前，但直调 apply / 旧 profile 绕过 Loader 时仍可能传入非法值——此时
 * 通过 onInvalid 上报（宿主 logger.warn），不再静默回退。 */
export function normalizeConfig(
  source: unknown,
  defaults: SessionArchiveConfig = DEFAULT_CONFIG,
  onInvalid?: (message: string) => void,
): SessionArchiveConfig {
  const raw = source !== null && typeof source === 'object' && !Array.isArray(source)
    ? source as Partial<Record<keyof SessionArchiveConfig, unknown>>
    : {};
  const positiveInt = (key: keyof SessionArchiveConfig): number => {
    // undefined 视为未配置（用默认值）；null/字符串/0/浮点等显式非法值走告警回退。
    const value = raw[key] !== undefined ? raw[key] : defaults[key];
    if (Number.isInteger(value) && (value as number) > 0) return value as number;
    // 上报原值（含字符串/浮点/0），日志里能看出用户到底写错了什么。
    const shown = JSON.stringify(value) ?? String(value);
    onInvalid?.(`session-archive: invalid config "${key}"=${shown}; using default ${defaults[key]}`);
    return defaults[key];
  };
  return {
    detailMaxMessages: positiveInt('detailMaxMessages'),
    messagePreviewChars: positiveInt('messagePreviewChars'),
    titleReadConcurrency: positiveInt('titleReadConcurrency'),
  };
}
