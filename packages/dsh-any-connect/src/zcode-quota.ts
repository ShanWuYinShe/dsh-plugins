/**
 * ZCode Coding Plan 的窗口额度（5 小时 / 7 天 / 工具调用）。
 *
 * 端点是 ZCode 客户端 `BigModelUsageQuotaProvider` 用的同一支：
 *
 *     GET https://bigmodel.cn/api/monitor/usage/quota/limit
 *     Authorization: Bearer <coding-plan api-key>
 *
 * 2026-10-08 实测响应：
 *
 *     { "code": 200, "data": { "level": "pro", "limits": [
 *       { "type": "TOKENS_LIMIT", "unit": 3, "number": 5, "percentage": 0,  "nextResetTime": 1791403544725 },
 *       { "type": "TOKENS_LIMIT", "unit": 6, "number": 1, "percentage": 24, "nextResetTime": 1791865446983 },
 *       { "type": "TIME_LIMIT",   "unit": 5, "number": 1, "usage": 1000,
 *         "currentValue": 0, "remaining": 1000, "nextResetTime": 1793026354999 } ] } }
 *
 * 语义（unit 取值来自客户端 schema 与实测时间差）：3 = 小时、6 = 周、5 = 月；
 * `TOKENS_LIMIT` 只给 `percentage`（**已用**百分比，与客户端展示的进度一致），
 * 所以窗口表达成「还剩百分之多少」：remain = 100 - percentage、limit = 100；
 * `TIME_LIMIT` 给 `usage/currentValue/remaining`，单位是调用次数。
 *
 * 这里只做解析与映射，不碰网络：取数在 {@link ZCodeUpstreamClient.fetchCodingPlanQuota}。
 *
 * @module dsh-any-connect/zcode-quota
 */

/** One entry of `data.limits` as the monitor endpoint declares it. */
export interface ZCodeQuotaLimit {
  type: string
  /** 3 = 小时、6 = 周、5 = 月（实测口径，未知取值按通用标签展示）。 */
  unit?: number
  /** 与 `unit` 组合出的窗口大小（5 小时 / 1 周 / 1 月）。 */
  number?: number
  /** 已用百分比（TOKENS_LIMIT 用它，客户端界面显示的就是这个数）。 */
  percentage?: number
  /** TIME_LIMIT：总额度（次数）。 */
  usage?: number
  /** TIME_LIMIT：已用次数。 */
  currentValue?: number
  /** TIME_LIMIT：剩余次数。 */
  remaining?: number
  /** 下次重置时刻（毫秒 epoch）。 */
  nextResetTime?: number
}

/** Parsed `/api/monitor/usage/quota/limit` answer. */
export interface ZCodeCodingPlanQuota {
  /** 订阅档位（实测 "pro"），只有展示意义。 */
  level?: string
  limits: readonly ZCodeQuotaLimit[]
}

/** One pill window, structurally matching provider-usage's `UsageWindow`. */
export interface ZCodeQuotaWindow {
  id: string
  label: string
  remain?: number
  limit?: number
  unit: string
  resetsAt?: string
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isoOrUndefined(ms: unknown): string | undefined {
  const value = numberOrUndefined(ms)
  if (value === undefined || value <= 0) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * 解析 monitor 端点响应；形状不符（含把别的端点响应喂进来的情况：`data` 是数组、
 * `limits` 缺失或为空）时返回 undefined，调用方据此回退。
 */
export function parseCodingPlanQuota(json: unknown): ZCodeCodingPlanQuota | undefined {
  const data = (json as { data?: unknown } | null | undefined)?.data
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) return undefined
  const limitsRaw = (data as { limits?: unknown }).limits
  if (!Array.isArray(limitsRaw)) return undefined
  const limits: ZCodeQuotaLimit[] = []
  for (const entry of limitsRaw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const type = (entry as { type?: unknown }).type
    if (typeof type !== 'string' || type.trim() === '') continue
    limits.push({
      type: type.trim(),
      ...Object.fromEntries(
        (['unit', 'number', 'percentage', 'usage', 'currentValue', 'remaining', 'nextResetTime'] as const)
          .map(key => [key, numberOrUndefined((entry as Record<string, unknown>)[key])] as const)
          .filter(([, value]) => value !== undefined),
      ) as Omit<ZCodeQuotaLimit, 'type'>,
    })
  }
  if (limits.length === 0) return undefined
  const level = (data as { level?: unknown }).level
  return {
    ...(typeof level === 'string' && level.trim() !== '' ? { level: level.trim() } : {}),
    limits,
  }
}

/**
 * 一个窗口的展示名。unit/number 组合按实测口径翻译：3=小时、6=周（1 周按「7 天」
 * 写，用户的心智模型是天）、5=月；TOKENS_LIMIT 之外的类型（TIME_LIMIT）是工具
 * 调用次数，单独命名。
 */
export function codingPlanWindowLabel(limit: ZCodeQuotaLimit): string {
  if (limit.type === 'TIME_LIMIT') return '工具调用'
  const size = limit.number !== undefined && limit.number > 0 ? limit.number : 1
  if (limit.unit === 3) return `${size} 小时`
  if (limit.unit === 6) return size === 1 ? '7 天' : `${size * 7} 天`
  if (limit.unit === 5) return size === 1 ? '1 个月' : `${size} 个月`
  return '额度'
}

/**
 * 把 limits 映射成 pill 窗口，保持上游顺序（5 小时在第一位 = pill 的 headline）。
 *
 * - `TOKENS_LIMIT`：percentage 是**已用**百分比，窗口报剩余的百分比；
 * - `TIME_LIMIT`：报剩余/总调用次数；
 * - 两者都缺可展示数字时跳过该行，而不是造一个空窗口。
 */
export function codingPlanQuotaWindows(quota: ZCodeCodingPlanQuota): readonly ZCodeQuotaWindow[] {
  const windows: ZCodeQuotaWindow[] = []
  const seen = new Set<string>()
  for (const limit of quota.limits) {
    const resetsAt = isoOrUndefined(limit.nextResetTime)
    const baseId = `${limit.type.toLowerCase()}-${limit.unit ?? 0}-${limit.number ?? 0}`
    let id = baseId
    let suffix = 2
    while (seen.has(id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }
    seen.add(id)
    const label = codingPlanWindowLabel(limit)
    if (limit.type === 'TIME_LIMIT') {
      const remain = numberOrUndefined(limit.remaining)
      const total = numberOrUndefined(limit.usage)
      if (remain === undefined && total === undefined) continue
      windows.push({
        id,
        label,
        ...remain === undefined ? {} : { remain },
        ...total === undefined ? {} : { limit: total },
        unit: '次',
        ...resetsAt === undefined ? {} : { resetsAt },
      })
      continue
    }
    const percentage = numberOrUndefined(limit.percentage)
    if (percentage === undefined) continue
    const used = Math.min(100, Math.max(0, percentage))
    windows.push({
      id,
      label,
      remain: Math.max(0, 100 - used),
      limit: 100,
      unit: '%',
      ...resetsAt === undefined ? {} : { resetsAt },
    })
  }
  return windows
}
