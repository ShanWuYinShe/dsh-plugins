/**
 * values.ts — 跨模块共用的 `unknown` 值助手：对象守卫、错误文本归一与过线脱敏。
 *
 * 2026-10-29 抽出（代码优雅化）：`isObject` 曾在两个协议解析模块各写一份、
 * `error instanceof Error ? error.message : String(error)` 在 8 处逐字重复。
 * 两者都是「未知输入如何安全落到字符串/记录」的唯一口径，只该有一个实现——
 * 口径一旦分叉，日志与解析行为就会悄悄不一致。
 *
 * 2026-10-30：`safeMessage` 从 web-status.ts 迁入——宿主状态路由、探针路由与
 * 回环 shim 的错误体都要过同一份脱敏，放在本叶子模块也避免 web-status ↔ shim
 * 之间的 import 环。
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

/**
 * Redact token-like content before it crosses to a client.
 *
 * 状态路由（web-status）、探针路由（probe-route）与回环 shim 的错误体都是
 * 「错误文本可能带着上游/凭据碎片回到调用方」的出口，口径必须只有这一份。
 * JWT 与 `code=/token=/refresh_token=/access_token=/api_key=` 类查询串一律替换，
 * 超长截到 500 字符（错误体只需要可诊断的首段，不是整段上游回显）。
 *
 * `api_?key=` 等公共规则与 provider-usage 的 safeMessage 同口径：跨包独立发布
 * 不能互 import，但两边共用的规则集应保持一致。
 */
export function safeMessage(error: unknown): string {
  return errorMessage(error)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token|api_?key)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}
