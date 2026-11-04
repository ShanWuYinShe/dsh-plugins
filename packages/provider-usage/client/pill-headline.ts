/**
 * pill-headline.ts — pill 头行文案纯函数（useProviderUsage 内联四层三元的抽取）。
 *
 * @module provider-usage/pill-headline
 */

import { resolveUsageLabel, type UsageRateLimit, type UsageSnapshot } from '../src/types.js'
import { isQueriedAnswer, type SnapshotAnswer } from './fetch-snapshot.js'
import { formatAmount, formatReset } from './pill-format.js'
import type { ProviderUsageLocaleKey } from './locales.js'

/** 文案函数（与注入的 t 同形）。 */
type PillCopy = (key: ProviderUsageLocaleKey, params?: Record<string, unknown>) => string

/**
 * 单位后缀：unit 可能为空串（订阅有效性窗口没有计量单位），此时不留多余空格/冒号。
 *
 * @param unit - the window's unit.
 * @returns " unit", or "" when the window names no unit.
 */
function unitSuffix(unit: string): string {
  return unit === '' ? '' : ` ${unit}`
}

/**
 * 头行文案：7 个分支（loading / noQuerier / rateLimited / failed / noWindows /
 * label形 / 额度形）+ stale 后缀。
 *
 * 限流排在窗口数字之前：通道正在拒收请求时，「还剩 80%」是误导——用户此刻
 * 发不出请求，他要知道的是什么时候能发。额度仍然在展开面板里，不丢信息。
 * 上游按模型限流时头行会带上模型名（`限流中 · glm-5.3`），避免整体误读。
 *
 * 额度用尽时头行仍是「0 credits 剩余」（诚实），恢复时刻由
 * {@link exhaustedResetText} 追加在按钮的 title/aria 上，不挤占折叠态宽度。
 *
 * @param answer - 资源流答案（快照或未查询标记）。
 * @param provider - 当前 provider 键。
 * @param stale - 是否标记「数据可能过期」。
 * @param t - 文案函数。
 * @param localeId - DSH 当前语言 id；数字/时间格式化随它走，缺席用浏览器默认。
 * @returns 折叠态头行文案。
 */
export function headlineText(answer: SnapshotAnswer | undefined, provider: string, stale: boolean, t: PillCopy, localeId?: string): string {
  const snapshot = isQueriedAnswer(answer) ? answer : undefined
  const first = snapshot?.windows[0]
  let headline: string
  if (answer === undefined) {
    headline = t('loading')
  } else if (snapshot === undefined) {
    headline = t('noQuerier', { provider })
  } else if (snapshot.rateLimit !== undefined) {
    headline = rateLimitHeadline(snapshot.rateLimit, t, localeId)
  } else if (snapshot.error !== undefined && snapshot.windows.length === 0) {
    headline = t('failed')
  } else if (first === undefined) {
    headline = t('noWindows')
  } else {
    /** 多个窗口只在头行报第一个，「 +N」提示展开还有更多。 */
    const more = snapshot.windows.length > 1 ? ` +${snapshot.windows.length - 1}` : ''
    const label = resolveUsageLabel(first.label, localeId)
    const unit = resolveUsageLabel(first.unit, localeId)
    headline = first.remain === undefined
      ? `${label}${unit === '' ? '' : `: ${unit}`}${more}`
      : `${formatAmount(first.remain, localeId)}${unitSuffix(unit)} ${t('remaining')}${more}`
  }
  return stale ? `${headline} · ${t('staleData')}` : headline
}

/**
 * 折叠态是否该补上「什么时候恢复」。
 *
 * 只在**真的用尽**时补：remain 为 0 且窗口声明了 resetsAt（GLM Coding Plan 的
 * 5 小时积分、OpenRouter 的日预算等都是这种「会回填的限额」）。还有余额时补
 * 恢复时间只是噪音——用户此刻能继续用。
 *
 * 这是用户问的「到底到什么时候我可以接着用」在额度这一侧的直接答案；
 * 限流那一侧由 {@link rateLimitHeadline} 负责，两条通道互不替代。
 */
export function exhaustedResetText(snapshot: UsageSnapshot, t: PillCopy, localeId?: string): string | undefined {
  const first = snapshot.windows[0]
  if (first === undefined || first.remain !== 0 || first.resetsAt === undefined) return undefined
  return t('resetsAt', { time: formatReset(first.resetsAt, localeId) })
}

/**
 * 限流态文案：有上游给的恢复时刻就说几点，没有就如实说「上游没给」。
 *
 * 绝不按固定窗口推算——GLM Coding Plan 的限流是按订阅档位并发动态调整的
 * （官方 usage-policy 原文），不存在可推算的窗口；编一个倒计时比不说更糟。
 */
export function rateLimitHeadline(rateLimit: UsageRateLimit, t: PillCopy, localeId?: string): string {
  const base = rateLimit.resetAt === undefined
    ? t('rateLimitedUnknown')
    : t('rateLimitedUntil', { time: formatReset(new Date(rateLimit.resetAt).toISOString(), localeId) })
  // 上游的限流是**按模型**的（WorkBuddy 尤其如此）：头行必须带上模型名，
  // 否则用户会把「A 模型被限」误读成「整个 provider 不能用」。
  return rateLimit.model === undefined ? base : `${base} · ${rateLimit.model}`
}
