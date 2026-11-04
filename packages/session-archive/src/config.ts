/**
 * config.ts — 插件配置的公开形状与 Cordis Loader 校验 schema。
 *
 * function plugin 的 `Config` 是 Loader 认识的配置契约：Loader 在激活前用
 * schema 校验/补默认值（误配置 fail loud，不再静默回退），Plugins 页也据此
 * 渲染配置表单。默认值与 plugin-config.ts 的 DEFAULT_CONFIG 同源——两处
 * 各写一份数字会让 patch 表单/运行时口径悄悄漂移，故 schema 直接引用它。
 *
 * @module @chaoset/session-archive/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONFIG } from './plugin-config.js'
import type { SessionArchiveConfig } from './plugin-config.js'

/** 插件配置（与归一化后的 SessionArchiveConfig 同三字段，入口导出的类型面）。 */
export interface Config extends SessionArchiveConfig {}

/** 配置 schema：三个字段都是正整数（0 与小数、负数均判非法）。 */
export const Config = z.object({
  detailMaxMessages: z.natural().min(1).default(DEFAULT_CONFIG.detailMaxMessages)
    .description('detail() 返回的最大消息条数（超出仅计数）'),
  messagePreviewChars: z.natural().min(1).default(DEFAULT_CONFIG.messagePreviewChars)
    .description('每条消息预览的最大字符数（超出截断加省略号）'),
  titleReadConcurrency: z.natural().min(1).default(DEFAULT_CONFIG.titleReadConcurrency)
    .description('list() 并发读取标题的最大并行数'),
})
