/** Browser-half copy for the composer-dock usage pill. */

/** Dictionary keys owned by this package's locale namespace. */
export type ProviderUsageLocaleKey =
  | 'loading'
  | 'remaining'
  | 'noQuerier'
  | 'noQuerierHint'
  | 'noWindows'
  | 'failed'
  | 'refreshing'
  | 'plan'
  | 'resetsAt'
  | 'windowRemaining'
  | 'providerUsageTitle'
  | 'refresh'
  | 'staleData'
  | 'rateLimited'
  | 'rateLimitedUntil'
  | 'rateLimitedUnknown'
  | 'rateLimitHits'
  | 'rateLimitWindow'
  | 'blocked'

export const en: Record<ProviderUsageLocaleKey, string> = {
  loading: 'Loading usage…',
  remaining: 'left',
  noQuerier: '{provider} usage is not reported',
  noQuerierHint: 'No billing query API is published for this provider; usage is metered per request.',
  noWindows: 'This provider reports no quota',
  failed: 'Usage unavailable',
  refreshing: 'Refreshing…',
  plan: 'Plan',
  resetsAt: 'Resets {time}',
  windowRemaining: '{remain} / {limit}',
  providerUsageTitle: 'Provider usage',
  refresh: 'Refresh',
  staleData: 'may be stale',
  rateLimited: 'rate limited',
  rateLimitedUntil: 'Rate limited · back {time}',
  rateLimitedUnknown: 'Rate limited · reset time not reported',
  rateLimitHits: '{count} refusals',
  rateLimitWindow: '{seconds}s window',
  blocked: 'blocked',
}

export const zh: Record<ProviderUsageLocaleKey, string> = {
  loading: '正在读取额度…',
  remaining: '剩余',
  noQuerier: '{provider} 未提供额度查询',
  noQuerierHint: '当前 provider 暂未开放账单查询接口，模型调用随请求自动计费。',
  noWindows: '该 provider 不上报额度',
  failed: '额度不可用',
  refreshing: '刷新中…',
  plan: '套餐',
  resetsAt: '{time} 重置',
  windowRemaining: '{remain} / {limit}',
  providerUsageTitle: 'Provider 额度',
  refresh: '刷新',
  staleData: '数据可能过期',
  rateLimited: '限流中',
  rateLimitedUntil: '限流中 · {time} 恢复',
  rateLimitedUnknown: '限流中 · 上游未给恢复时间',
  rateLimitHits: '被拒 {count} 次',
  rateLimitWindow: '{seconds} 秒窗口',
  blocked: '已用尽',
}

/**
 * 注入面漂移时的英文兜底文案。
 *
 * `t` 来自宿主 inject 面；宿主契约变更（face 改名/延迟注入）时可能缺席。
 * 此时**不能抛错**：render 期抛错会被宿主 `reportEntryError({abdicate:true})`
 * 永久移出投影（见 client/index.tsx 文件头），而本包自带 en 字典，退回英文
 * 文案即可让 pill 继续存活。占位符语法与宿主 `t` 相同（`{name}`）。
 *
 * @param key - 本包字典键。
 * @param params - 占位符参数。
 * @returns 英文文案（缺参占位符原样保留）。
 */
export function fallbackTranslate(key: ProviderUsageLocaleKey, params?: Record<string, unknown>): string {
  // `?? key`：静态类型保证 key 一定在字典里，但这一层就是为契约漂移兜底的，
  // 不认识 key 时显示 key 本身，绝不在这里再抛一次错。
  const template = en[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (placeholder, name: string) => name in params ? String(params[name]) : placeholder)
}
