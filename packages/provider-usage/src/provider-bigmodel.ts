/**
 * provider-bigmodel.ts — BigModel (Zhipu AI) 的额度查询器。
 *
 * @module @chaoset/provider-usage/provider-bigmodel
 */

import type { ProviderUsageQuerier, UsageWindow } from './types.js'
import { num, str, rec, records, snapshotOf, getJson, trimBase } from './provider-shared.js'

/**
 * BigModel (Zhipu AI) Coding Plan and subscription quota.
 *
 * First checks `GET {base}/api/monitor/usage/quota/limit`, which returns rolling
 * 5-hour and weekly limits. If unavailable or empty, falls back to the
 * subscription list — under the configured baseURL first (proxy/dedicated
 * deployments must not hairpin to the public internet), then the public URL.
 */

/** 默认 quota 根；用户配了代理/专线 baseURL 时订阅回退优先走它，不直连公网。 */
const QUOTA_ROOT_DEFAULT = 'https://open.bigmodel.cn'
/** 订阅回退的公网兜底（默认根或回退无果时才用）。 */
const SUBSCRIPTION_PUBLIC_URL = 'https://bigmodel.cn/api/biz/subscription/list'

/**
 * 上游订阅 `expireTime` 的绝对时刻（ISO-8601），只在字符串自带时区时给出。
 *
 * 上游返回的常见形态是 `YYYY-MM-DD HH:mm:ss`（不带时区）：按宿主本地时区或
 * UTC 解释都会偏最多一个时区差，而 `UsageWindow.resetsAt` 的契约要求绝对时刻
 * （types.ts），所以时区不确定时宁可不输出——界面按「未提供恢复时间」处理，
 * 比显示一个可能错几小时的时间诚实。
 *
 * @param value - upstream `expireTime` text, when reported.
 * @returns the ISO instant, or undefined when the text names no absolute instant.
 */
function absoluteInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = value.trim()
  // 只有自带 Z / ±hh:mm 偏移的形态才代表绝对时刻；无时区的本地时刻不猜。
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/u.test(text)) return undefined
  const at = new Date(text)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

export const bigmodelUsage: ProviderUsageQuerier = async ({ baseURL, apiKey, signal }) => {
  if (apiKey === undefined) return snapshotOf('bigmodel', [])
  const root = trimBase(baseURL ?? QUOTA_ROOT_DEFAULT)
  const headers = { authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}` }
  const windows: UsageWindow[] = []
  let plan: string | undefined

  try {
    const body = await getJson(`${root}/api/monitor/usage/quota/limit`, headers, signal)
    const data = rec(body['data'])
    const limits = records(data['limits'])
    for (const lim of limits) {
      const type = str(lim['type']) ?? 'QUOTA'
      const percentage = num(lim['percentage'])
      const nextReset = num(lim['nextResetTime'])
      const label = type === 'TOKENS_LIMIT' ? 'Token limit' : type === 'TIME_LIMIT' ? 'Time limit' : type
      if (percentage !== undefined) {
        const remain = Math.max(0, 100 - percentage)
        windows.push({
          id: type.toLowerCase(),
          label,
          remain,
          limit: 100,
          unit: '%',
          ...nextReset !== undefined && nextReset > 0 ? { resetsAt: new Date(nextReset).toISOString() } : {},
        })
      }
    }
    if (windows.length > 0) plan = 'Coding Plan'
  } catch {
    // Coding Plan endpoint not reachable or not supported on this account
  }

  if (windows.length === 0) {
    const subscriptionUrls = root === QUOTA_ROOT_DEFAULT || root === 'https://bigmodel.cn'
      ? [SUBSCRIPTION_PUBLIC_URL]
      : [`${root}/api/biz/subscription/list`, SUBSCRIPTION_PUBLIC_URL]
    for (const url of subscriptionUrls) {
      try {
        const body = await getJson(url, headers, signal)
        const list = records(rec(body['data'])['list'])
        for (const item of list) {
          const status = str(item['status'])
          const productName = str(item['productName']) ?? 'Subscription'
          if (status === 'VALID') {
            plan = productName
            const resetsAt = absoluteInstant(str(item['expireTime']))
            windows.push({
              id: `sub-${productName.toLowerCase().replace(/\s+/g, '-')}`,
              label: productName,
              // 订阅有效性不是额度：没有 remain/limit，也就没有计量单位
              // （空串 = 无单位；client 与 /usage 都按「无单位」渲染）。
              unit: '',
              ...resetsAt === undefined ? {} : { resetsAt },
            })
          }
        }
        if (windows.length > 0) break
      } catch {
        // Try the next subscription source.
      }
    }
  }

  return snapshotOf('bigmodel', windows, {
    plan,
    error: 'the quota endpoint reported no usable quota or subscription',
  })
}
