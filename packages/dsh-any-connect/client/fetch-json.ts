/**
 * fetch-json.ts — client 侧 JSON 响应读取共用助手。
 *
 * useVariantCard / useVariantsPage 此前各抄一份 `response.json().catch →
 * !ok → detail → throw`，与 host 侧 httpStatusLabel 纪律对齐：错误统一
 * `HTTP_xxx` 形（浏览器侧虽无宿主正则扫描，保持同形避免两套口径）。
 *
 * @module dsh-any-connect/fetch-json
 */

/** 读 JSON 体；非 2xx 按 `HTTP_xxx[: detail]` 抛错。 */
export async function fetchJsonOrThrow(response: Promise<Response> | Response): Promise<unknown> {
  const resolved = await response
  const value: unknown = await resolved.json().catch(() => undefined)
  if (!resolved.ok) {
    const detail = typeof (value as { error?: unknown } | null)?.error === 'string'
      ? `: ${(value as { error: string }).error}`
      : ''
    throw new Error(`HTTP_${resolved.status}${detail}`)
  }
  return value
}
