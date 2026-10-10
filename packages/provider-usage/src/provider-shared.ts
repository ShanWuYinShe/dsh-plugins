/**
 * provider-shared.ts — 内置 querier 共用的取值助手与 JSON 请求。
 *
 * 2026-10-08 从 521 行的 providers.ts 拆出：每个 provider 一个文件，共享取值助手
 * 单独成模块，providers.ts 只保留内置注册表与 re-export。
 *
 * @module @chaoset/provider-usage/provider-shared
 */



/** Read a finite number from either a JSON number or a numeric string. */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Read a non-empty string. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Read a nested record, or an empty one so callers can chain reads safely. */
export function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/** Read an array of records, dropping entries that are not records. */
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry)) as Record<string, unknown>[] : []
}

/** GET a JSON document, failing loud on a non-2xx so the registry can report it. */
export async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    ...signal === undefined ? {} : { signal },
  })
  const text = await response.text()
  if (!response.ok) {
    // The body may quote the credential it rejected; the registry redacts
    // before this crosses to the browser, but keep the excerpt short anyway.
    throw new Error(`${new URL(url).host} responded ${response.status}: ${text.slice(0, 160)}`)
  }
  try {
    return rec(JSON.parse(text))
  } catch {
    throw new Error(`${new URL(url).host} returned a non-JSON body`)
  }
}

/** Trim trailing slashes so a configured baseURL joins cleanly. */
export function trimBase(baseURL: string): string {
  return baseURL.replace(/\/+$/u, '')
}

/**
 * Join a (trimmed) root with a `/...` path, without doubling `/v1` when the
 * user configured a baseURL that already ends with it (`.../api/v1` +
 * `/v1/key` used to produce `.../api/v1/v1/key`, a certain 404).
 */
export function joinRoot(root: string, path: string): string {
  const base = trimBase(root)
  if (path.startsWith('/v1/') && base.endsWith('/v1')) return `${base}${path.slice(3)}`
  return `${base}${path}`
}
