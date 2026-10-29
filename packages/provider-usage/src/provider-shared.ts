/**
 * provider-shared.ts — 内置 querier 共用的取值助手、JSON 请求与快照组装。
 *
 * @module @chaoset/provider-usage/provider-shared
 */

import type { UsageSnapshot, UsageWindow } from './types.js'

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

/** 快照里由查询器自报、与窗口列表无关的元数据。 */
interface UsageSnapshotExtras {
  /** Provider-reported plan or tier name, when disclosed. */
  plan?: string
  /**
   * 查询器为什么答不出可用数据。**只在 windows 为空时写入**：有窗口的答案
   * 描述的是「额度」，不是「查询失败」——两者是 types 契约里两个不同的陈述。
   */
  error?: string
}

/**
 * 组装一份查询快照，统一「空 windows + error = 软失败」的口径。
 *
 * 每个内置查询器都遵循同一条返回纪律，集中在这里而不是在 8 个文件里各写
 * 一遍条件展开：`fetchedAt` 取调用时刻；`plan` 有就带上；`error` 只在
 * 没有可用窗口时出现（有窗口还带 error 会把「余额读数」显示成「查询失败」）。
 *
 * @param provider - provider route key the answer belongs to.
 * @param windows - reported windows, in the provider's own order.
 * @param extras - optional plan name and the empty-windows failure text.
 * @returns the snapshot a querier hands back to the registry.
 */
export function snapshotOf(provider: string, windows: UsageWindow[], extras: UsageSnapshotExtras = {}): UsageSnapshot {
  return {
    provider,
    windows,
    fetchedAt: Date.now(),
    ...extras.plan === undefined ? {} : { plan: extras.plan },
    ...windows.length === 0 && extras.error !== undefined ? { error: extras.error } : {},
  }
}
