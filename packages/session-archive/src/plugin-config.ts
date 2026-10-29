/**
 * plugin-config.ts — 插件身份（name/inject）与配置默认值、校验、归一化。
 *
 * 2026-10-08 从 897 行的 src/index.ts 拆出：扫描助手、配置与 host 工厂各自成
 * 模块，入口只保留网关接线与 apply。
 *
 * @module @chaoset/session-archive/plugin-config
 */



export const name = 'session-archive';

/** sessions 参与 inject：删除前必须能查询 live 会话（存在即拒绝删除）。 */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions'];

/**
 * 默认配置。apply 时与 YAML 传入的 config 合并。
 *
 * 不要从插件入口导出小写 `config`：Cordis 的插件元数据只认大写 `Config`
 * schema，entry 的 config 来自 profile patch，小写导出从不被读取（2026-10-29
 * 清除遗留死导出；入口面锁 test/entry-surface.test.ts 会拦住它长回来）。
 */
export const DEFAULT_CONFIG = {
  /** detail() 返回的最大消息条数（超出仅计数）。 */
  detailMaxMessages: 200,
  /** 每条消息预览的最大字符数（超出截断加省略号）。 */
  messagePreviewChars: 2000,
  /** list() 时并发读取标题的最大并行数。 */
  titleReadConcurrency: 4,
};

/** 配置校验：只接受正整数数值字段，避免脏配置拖垮并发/截断逻辑。 */
export function validateConfig(partial: any) {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new TypeError('session-archive config must be a plain object');
  }
  for (const key of ['detailMaxMessages', 'messagePreviewChars', 'titleReadConcurrency']) {
    if (partial[key] !== undefined && (!Number.isInteger(partial[key]) || partial[key] <= 0)) {
      throw new TypeError(`session-archive config field "${key}" must be a positive integer`);
    }
  }
}

/** 配置归一化：非法/缺失数值回退默认值，保证运行时不会拿到 NaN/负数。 */
export function normalizeConfig(source: any, defaults: any = DEFAULT_CONFIG): Record<string, any> {
  const raw = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const merged = { ...defaults, ...raw };
  const positiveInt = (value: any, fallback: any) => Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    detailMaxMessages: positiveInt(merged.detailMaxMessages, defaults.detailMaxMessages),
    messagePreviewChars: positiveInt(merged.messagePreviewChars, defaults.messagePreviewChars),
    titleReadConcurrency: positiveInt(merged.titleReadConcurrency, defaults.titleReadConcurrency),
  };
}
