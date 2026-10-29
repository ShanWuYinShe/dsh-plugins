/**
 * RateLimitBox.tsx — provider 卡片里的上游限流提示框。
 *
 * 2026-10-29 新增。用户要的是「到底到什么时候可以接着用」，所以这个框只回答
 * 两件事，且都必须**是上游说过的事实**：
 *
 * - 上游给了恢复时刻（`Retry-After` / `X-RateLimit-Reset`）→ 说几点恢复；
 * - 上游没给 → 如实说「未提供恢复时间」，并给出被限起点与撞了几次，让用户
 *   自己判断要不要等。
 *
 * 绝不按固定窗口推算倒计时：GLM Coding Plan 的并发限流按订阅档位动态调整，
 * 根本不存在可推算的窗口（官方 rate-limit 文档原文），编一个只会骗人。
 *
 * @module dsh-any-connect/client/RateLimitBox
 */

import { planMetaStyle, rateLimitBoxStyle, rateLimitTitleStyle, rateLimitLineStyle } from './config-styles.js'
import type { WorkBuddyWebRateLimit } from '../src/status-paths.js'
import type { WorkBuddyConfigPageInjected } from './config-types.js'

/** 相对时间：秒级到分钟级用「x 秒前」，更久用绝对时刻。 */
function formatElapsed(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.round(minutes / 60)
  return `${hours}h`
}

/** 恢复时刻：今天的给时分，跨天给日期。 */
function formatResetTime(atMs: number, nowMs: number): string {
  const at = new Date(atMs)
  const now = new Date(nowMs)
  const sameDay = at.getFullYear() === now.getFullYear()
    && at.getMonth() === now.getMonth()
    && at.getDate() === now.getDate()
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function RateLimitBox({ t, rateLimit, nowMs }: {
  t: WorkBuddyConfigPageInjected['t']
  rateLimit: WorkBuddyWebRateLimit | undefined
  /** 渲染基准时刻（可注入，测试不依赖真实时钟）。 */
  nowMs?: number
}): React.ReactNode {
  if (rateLimit === undefined) return null
  const now = nowMs ?? Date.now()

  return (
    <div style={rateLimitBoxStyle} role="status">
      <span style={rateLimitTitleStyle}>{t('rateLimitTitle')}</span>
      <span style={rateLimitLineStyle}>
        {rateLimit.resetAt === undefined
          // 上游没给恢复时间：说清「已等多久 + 撞了几次」，让用户自己判断。
          ? t('rateLimitUnknownReset', { elapsed: formatElapsed(rateLimit.blockedAt, now) })
          : t('rateLimitResetsAt', { time: formatResetTime(rateLimit.resetAt, now) })}
      </span>
      <span style={planMetaStyle}>
        {t('rateLimitMeta', {
          count: String(rateLimit.hits),
          model: rateLimit.model ?? t('rateLimitAnyModel'),
        })}
      </span>
    </div>
  )
}
