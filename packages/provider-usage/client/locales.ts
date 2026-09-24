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
  | 'expand'
  | 'collapse'
  | 'providerUsageTitle'
  | 'emptyProvider'

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
  expand: 'Expand',
  collapse: 'Collapse',
  providerUsageTitle: 'Provider usage',
  emptyProvider: 'No provider',
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
  expand: '展开',
  collapse: '收起',
  providerUsageTitle: 'Provider 额度',
  emptyProvider: '无 provider',
}
