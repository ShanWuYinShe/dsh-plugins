/**
 * values.ts — 跨模块共用的 `unknown` 值助手：对象守卫与错误文本归一。
 *
 * 2026-10-29 抽出（代码优雅化）：`isObject` 曾在两个协议解析模块各写一份、
 * `error instanceof Error ? error.message : String(error)` 在 8 处逐字重复。
 * 两者都是「未知输入如何安全落到字符串/记录」的唯一口径，只该有一个实现——
 * 口径一旦分叉，日志与解析行为就会悄悄不一致。
 *
 * 刻意保持零依赖（不 import 任何模块）：本模块被凭据、上游、状态、CLI 各层共用。
 *
 * @module dsh-any-connect/values
 */

/** 非 null、非数组的对象记录（JSON 对象的形状守卫）。 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 任意抛出值的可读文本：Error 取 message，其余 String()。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
