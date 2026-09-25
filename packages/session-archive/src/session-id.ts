/**
 * session id 断言 — remote.ts 方法层与 typert.host.ts codec 层共享的入参校验。
 *
 * 两层都对网关入参做同形校验，历史注释声称"两处语义一致（改一处必须改
 * 另一处）"——实际曾漂移（方法层漏了非空与上限）。抽成单一来源后漂移
 * 不再可能：两层引用同一实现，改一处即两处。
 */

/** 批量上限：面板勾选集现实中不足千级，超限直接拒绝（防网关层失控展开）。 */
export const SESSION_ID_ARRAY_LIMIT = 5000;

/** 单个会话 id：非空字符串。 */
export function assertSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("sessionArchive expects a non-empty session id string");
  }
  return value;
}

/** 会话 id 数组：每项非空字符串，且有总量上限。 */
export function assertSessionIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > SESSION_ID_ARRAY_LIMIT
    || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new TypeError("sessionArchive expects an array of non-empty session id strings");
  }
  return value;
}
