/**
 * pill-headline.ts — pill 头行文案纯函数（useProviderUsage 内联四层三元的抽取）。
 *
 * @module provider-usage/pill-headline
 */

import type { UsageSnapshot } from '../src/types.js'
import { formatAmount } from './pill-format.js'
import type { ProviderUsageLocaleKey } from './locales.js'

/** 路由返回的一行答案：快照，或未注册标记。 */
export type PillAnswer = UsageSnapshot | { provider: string; queried: false }

/** 文案函数（与注入的 t 同形）。 */
export type PillCopy = (key: ProviderUsageLocaleKey, params?: Record<string, unknown>) => string

/** 头行文案：6 个分支（loading / noQuerier / failed / noWindows / label形 / 额度形）+ stale 后缀。 */
export function headlineText(answer: PillAnswer | undefined, provider: string, stale: boolean, t: PillCopy): string {
  const queried = answer !== undefined && !('queried' in answer)
  const snapshot = queried ? answer as UsageSnapshot : undefined
  const headline = answer === undefined
    ? t('loading')
    : !queried
      ? t('noQuerier', { provider })
      : snapshot!.error !== undefined && snapshot!.windows.length === 0
        ? t('failed')
        : snapshot!.windows.length === 0
          ? t('noWindows')
          : snapshot!.windows[0]!.remain === undefined
            ? `${snapshot!.windows[0]!.label}: ${snapshot!.windows[0]!.unit}${snapshot!.windows.length > 1 ? ` +${snapshot!.windows.length - 1}` : ''}`
            : `${formatAmount(snapshot!.windows[0]!.remain ?? 0)} ${snapshot!.windows[0]!.unit} ${t('remaining')}${snapshot!.windows.length > 1 ? ` +${snapshot!.windows.length - 1}` : ''}`
  return stale ? `${headline} · ${t('staleData')}` : headline
}
