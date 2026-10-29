/**
 * session id 断言 — 归档 Remote 服务方法层的入参校验。
 *
 * 生成的 typert codec（./typert 工件）只按声明类型校验「字符串 / 字符串数组」
 * 的 JSON 形状，不会校验非空与批量上限；方法层保留本实现作为第二道防线
 * （单测直调方法也不经过网关 codec）。两层引用同一实现，语义不会漂移。
 */

/** 批量上限：面板勾选集现实中不足千级，超限直接拒绝（防网关层失控展开）。 */
const SESSION_ID_ARRAY_LIMIT = 5000;

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
  return value as string[];
}
