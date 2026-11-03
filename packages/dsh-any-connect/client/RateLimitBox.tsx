/**
 * RateLimitBox.tsx — provider 卡片里的上游限流提示框。
 *
 * 用户要的是「到底到什么时候可以接着用」，所以这个框只回答两件事，且都必须
 * **是上游说过的事实**：
 *
 * - 上游给了恢复时刻（响应头 `Retry-After` / `X-RateLimit-Reset`，或错误正文里
 *   的显式时刻）→ 说几点恢复；
 * - 上游没给 → 如实说「未提供恢复时间」，并给出被限起点与撞了几次，让用户
 *   自己判断要不要等。
 *
 * 上游按模型限流（WorkBuddy 的 cap-hit 以 modelId 为键），所以被限的可能不止
 * 一个模型：这里**一个模型一个框**，同时说明插件不拦截请求——请求是否放行
 * 完全由上游决定，用户随时可以继续试。
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

export function RateLimitBox({ t, rateLimits, nowMs }: {
  t: WorkBuddyConfigPageInjected['t']
  rateLimits: readonly WorkBuddyWebRateLimit[] | undefined
  /** 渲染基准时刻（可注入，测试不依赖真实时钟）。 */
  nowMs?: number
}): React.ReactNode {
  if (rateLimits === undefined || rateLimits.length === 0) return null
  const now = nowMs ?? Date.now()

  return (
    <>
      {rateLimits.map(observation => (
        <div key={observation.model ?? 'provider'} style={rateLimitBoxStyle} role="status">
          <span style={rateLimitTitleStyle}>{t('rateLimitTitle')}</span>
          <span style={rateLimitLineStyle}>
            {observation.resetAt === undefined
              // 上游没给恢复时间：说清「已等多久 + 撞了几次」，让用户自己判断。
              ? t('rateLimitUnknownReset', { elapsed: formatElapsed(observation.blockedAt, now) })
              : t('rateLimitResetsAt', { time: formatResetTime(observation.resetAt, now) })}
          </span>
          <span style={planMetaStyle}>
            {t('rateLimitMeta', {
              count: String(observation.hits),
              model: observation.model ?? t('rateLimitAnyModel'),
            })}
          </span>
        </div>
      ))}
      <span style={planMetaStyle}>{t('rateLimitNote')}</span>
    </>
  )
}
