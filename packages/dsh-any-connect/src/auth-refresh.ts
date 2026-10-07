/**
 * auth-refresh.ts — 凭据刷新策略：何时刷、怎么刷、刷完落盘。
 *
 * 2026-10-08 从 416 行的 auth-store.ts 拆出：刷新判定（margin / zcode 不刷）、失败退避、
 * 单飞与落盘兜底（落盘失败绝不丢刷新成果）同属「token 生命周期」，与文件读取/路径解析分开。
 *
 * 可变的节流状态放在 ctx.state 里由调用方持有，函数本身无隐藏状态。
 *
 * @module dsh-any-connect/auth-refresh
 */

import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { WorkBuddyCredential, WorkBuddyStoreOptions } from './auth-types.js'
import type { WorkBuddyVariant } from './variants.js'
import type { WorkBuddyRefreshOutcome } from './upstream.js'
import { ownDocument } from './auth-document.js'

/** 刷新节流状态（调用方持有，跨调用保持）。 */
export interface RefreshState {
  /** 落盘失败时的内存兜底：可能比磁盘副本新，进程退出即失。 */
  memoryCredential: WorkBuddyCredential | undefined
  /** 上一次刷新尝试（无论成败）的时刻。 */
  lastRefreshAttemptMs: number
  /** 上一次刷新**失败**的时刻（过期 token 的失败退避）。 */
  lastRefreshFailureMs: number
}

/** 刷新策略所需的上下文。 */
export interface RefreshContext {
  variant: WorkBuddyVariant
  refresh: WorkBuddyStoreOptions['refresh']
  refreshMarginMs: number
  ownPath: string
  onWarning: (message: string) => void
  state: RefreshState
}

/** 刷新响应缺 expiresIn 时新 access token 的保守寿命下限(10 分钟)。 */
const DEFAULT_EXPIRES_IN_SEC = 10 * 60

/** 「token 剩余寿命长于这个值就容忍一次刷新失败/无 refresh token」的下限。 */
const MIN_REUSABLE_LIFETIME_MS = 30_000

  export function needsRefresh(ctx: RefreshContext, credential: WorkBuddyCredential): boolean {
    if (ctx.variant.kind === 'zcode') return false
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + ctx.refreshMarginMs >= credential.expiresAtMs
  }

  export async function refreshNow(ctx: RefreshContext, credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + MIN_REUSABLE_LIFETIME_MS) return credential
      throw new Error('workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app')
    }
    let outcome: WorkBuddyRefreshOutcome
    try {
      outcome = await ctx.refresh(credential)
    } catch (error: unknown) {
      // 失败同样计入节流窗口（见 lastRefreshAttemptMs / lastRefreshFailureMs）。
      ctx.state.lastRefreshAttemptMs = Date.now()
      ctx.state.lastRefreshFailureMs = ctx.state.lastRefreshAttemptMs
      if (credential.expiresAtMs > Date.now() + MIN_REUSABLE_LIFETIME_MS) return credential
      throw new Error(
        `workbuddy: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy desktop app once to sign in again',
      )
    }
    ctx.state.lastRefreshAttemptMs = Date.now()
    const refreshed: WorkBuddyCredential = {
      ...credential,
      accessToken: outcome.accessToken,
      ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
      // 上游省略 expiresIn 时不能沿用旧过期时间:旧值必然已在刷新 margin
      // 内(否则不会走到这里),沿用会让 needsRefresh 恒真、每条请求都触发
      // 刷新。按保守下限外推;若真实寿命更短,后续请求的失败路径仍会再次
      // 尝试刷新。
      expiresAtMs: outcome.expiresInSec !== undefined
        ? Date.now() + outcome.expiresInSec * 1000
        : Date.now() + DEFAULT_EXPIRES_IN_SEC * 1000,
      ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
      source: 'dsh',
    }
    try {
      await saveOwn(ctx, refreshed)
      ctx.state.memoryCredential = undefined
    } catch (error: unknown) {
      // 落盘失败绝不丢刷新成果:上游可能已把 refresh token 轮换为一次性
      // 新值,退回磁盘上的旧副本会让下一次刷新必然 session_dead。内存兜底
      // 让本进程继续用新凭据,并把真实原因(磁盘写失败,而非上游刷新失败)
      // 送告警通道。
      ctx.state.memoryCredential = refreshed
      ctx.onWarning(
        'workbuddy: token refreshed but saving the plugin-owned copy failed'
        + ` (${String(error)}); the refreshed token is kept in memory only and will be lost on exit`,
      )
    }
    return refreshed
  }

  export async function saveOwn(ctx: RefreshContext, credential: WorkBuddyCredential): Promise<void> {
    await withFileLock(ctx.ownPath, async () => {
      await writeFileAtomic(ctx.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

