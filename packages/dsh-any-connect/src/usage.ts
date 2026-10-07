/**
 * usage.ts — provider-usage 的注册 seam 与 composer dock 的额度窗口助手。
 *
 * 2026-10-08 从 index.ts 提出：查询器注册与 pill 窗口构造（WorkBuddy 总积分 /
 * ZCode 当前套餐 / Start Plan 当日池 / Coding Plan 5 小时与 7 天窗口）是一件事，
 * 独立成模块后 index.ts 只负责把 runtime 列表接上去。
 *
 * registry 的服务面以结构类型声明（{@link ProviderUsageRegistryLike}）而不是
 * import：两个包独立安装，只有 provider-usage 的 owner 需要在它的服务面变化时
 * 改这里；宿主路由与浏览器 pill 都来自另一侧。
 *
 * @module dsh-any-connect/usage
 */

import type { Context } from '@deepseek-ai/cordis'
import { codingPlanQuotaWindows } from './zcode-quota.js'
import { variantIsStartPlan } from './variant-runtime.js'
import type { VariantRuntime } from './variant-runtime.js'
import type { WorkBuddyCredential } from './auth.js'
import type { WorkBuddyCreditAccount, WorkBuddyUpstreamClient, ZCodeUpstreamClient } from './upstream.js'

/**
 * The slice of @chaoset/provider-usage's registry this plugin calls.
 *
 * Declared structurally instead of imported: the two packages install
 * independently, and only the provider-usage owner should have to change when
 * its registry surface moves. If that surface changes, this is the mirror to
 * update — the host route and the browser pill both come from the other side.
 */
export interface ProviderUsageRegistryLike {
  register(provider: string, querier: (context: {
    provider: string
    baseURL?: string
    apiKey?: string
    signal?: AbortSignal
  }) => Promise<{
    provider: string
    displayName?: string
    plan?: string
    windows: readonly {
      id: string
      label: string
      remain?: number
      unit: string
      limit?: number
      resetsAt?: string
    }[]
    fetchedAt: number
    error?: string
  }>, displayName?: string): () => void
}

/**
 * pill 用总窗口：同币种分包求和为一个窗口（明细在配置页卡片里看）。
 * 全耗尽返回 []（pill 渲染无额度态）——与之前“过滤耗尽包”语义一致，
 * 只是行数永远 ≤1。跨币种/跨周期的窗口绝不在此合并：其它 provider 的
 * 窗口各有其语义，这里的 accounts 永远是同口径 credit 点数。
 *
 * Exported for tests: counted directly without booting the plugin.
 */
export function totalCreditsWindows(accounts: readonly WorkBuddyCreditAccount[]): Array<{
  id: string
  label: string
  remain: number
  unit: string
  limit?: number
}> {
  const live = accounts.filter(account => account.remain > 0)
  if (live.length === 0) return []
  const remain = live.reduce((sum, account) => sum + account.remain, 0)
  const limit = live.reduce((sum, account) => sum + (account.size > 0 ? account.size : 0), 0)
  return [{
    id: 'total',
    label: '总计',
    remain,
    unit: 'credits',
    ...limit > 0 ? { limit } : {},
  }]
}

/**
 * ZCode 当前套餐窗口：只取首个仍有剩余额度（无则取第一个），与配置页卡片
 * 的 zcodePlan 取法一致——pill 与卡片看到的是同一个“当前套餐”，而不是
 * 一摞计划名。
 *
 * Start Plan 的当日 token 池数字是真实的（billing/balance 的 remain/size），
 * 窗口必须带上它们——composer dock 的 pill 在窗口缺 remain 时只渲染
 * 「套餐名: 有效」，用户在聊天框下方就看不到剩余额度（2026-10-06 用户报告）。
 * Coding Plan 订阅的 remain/size 恒为 1，只是有效性标志而非用量，没有数字
 * 概念，维持「有效」展示；明细看配置页卡片。
 *
 * Exported for tests: counted directly without booting the plugin.
 */
export function currentPlanWindow(accounts: readonly WorkBuddyCreditAccount[]): Array<{
  id: string
  label: string
  remain?: number
  limit?: number
  unit: string
  resetsAt?: string
}> {
  const current = accounts.find(account => account.remain > 0) ?? accounts[0]
  if (current === undefined) return []
  const label = current.packageName.replace(/\s*\((?:有效|VALID|EXPIRED|已过期)\)$/i, '')
  // sameDay 是 Start Plan 当日池的特有标志（fetchStartPlanCredits 恒置）；
  // size > 0 才有进度条可画。remain = 0（当日用完）照样带数字——红色空条
  // 正是「今天用完了」的正确语义。
  if (current.sameDay === true && current.size > 0) {
    return [{
      id: 'plan',
      label,
      remain: current.remain,
      limit: current.size,
      unit: 'tokens',
      ...current.expiredAt ? { resetsAt: current.expiredAt } : {},
    }]
  }
  return [{
    id: 'plan',
    label,
    unit: '有效',
    ...current.expiredAt ? { resetsAt: current.expiredAt } : {},
  }]
}

/**
 * Start Plan 的 pill 窗口：当日池子存在时报真实 token 数（{@link currentPlanWindow}
 * 对 sameDay 池已带 remain/limit）；今天还没领取或尚未发放时**如实说「今日待领取」**，
 * 而不是让 pill 落到通用的「该 provider 不上报额度」——那会让用户以为额度功能坏了，
 * 而且额度接口本身是通的（billing/balance 返回空 balances 才是事实）。
 *
 * Exported for tests: counted directly without booting the plugin.
 */
export function startPlanWindows(accounts: readonly WorkBuddyCreditAccount[]): Array<{
  id: string
  label: string
  remain?: number
  limit?: number
  unit: string
  resetsAt?: string
}> {
  const windows = currentPlanWindow(accounts)
  if (windows.length > 0) return windows
  return [{ id: 'plan', label: 'Start Plan', unit: '今日待领取' }]
}

/**
 * Register one usage querier per variant against the optional provider-usage
 * registry.
 *
 * Usage readout: this plugin owns the WorkBuddy routes and already holds the
 * credential store that reads the desktop app's sign-in, so it is the right
 * place to answer "how much credit is left" — the provider-usage package
 * deliberately ships no WorkBuddy querier, because only this package knows
 * how to reach that app's billing endpoint. Absent provider-usage (the user
 * removed it), the registration never happens and the model channel is
 * unaffected.
 *
 * The service is read structurally through `ctx.get` rather than by
 * declaring `providerUsage` on Context: two packages declaring the same
 * member is a TypeScript error, and this package must not import the other's
 * types just to reach an optional neighbour (they install independently).
 *
 * @param client - fallback client for variants that never built their own.
 */
export function registerUsageQueriers(
  ctx: Context,
  runtimes: readonly VariantRuntime[],
  client: WorkBuddyUpstreamClient,
): void {
  ctx.inject(['providerUsage'], (usageCtx: Context) => {
    const usage = usageCtx.get('providerUsage') as ProviderUsageRegistryLike | undefined
    if (usage === undefined) return
    for (const runtime of runtimes) {
      usageCtx.effect(() => usage.register(
        runtime.variant.id,
        async context => {
          const credential = await runtime.store.resolve() as WorkBuddyCredential
          if (context.signal?.aborted === true) throw context.signal.reason ?? new Error('aborted')
          const credits = await (runtime.client ?? client).fetchCredits(credential)
          const isZCode = runtime.variant.kind === 'zcode'
          const isStartPlan = variantIsStartPlan(runtime.variant)
          // Coding Plan 的窗口额度（5 小时 / 7 天 / 工具调用）来自客户端同款
          // `GET bigmodel.cn/api/monitor/usage/quota/limit`：拿得到就按它展示，
          // 拿不到（网络 / 非 bigmodel 账号 / 形状变化）回退订阅有效性窗口。
          const quota = isZCode && !isStartPlan
            ? await (runtime.client as ZCodeUpstreamClient).fetchCodingPlanQuota(credential)
            : undefined
          const quotaWindows = quota === undefined ? [] : codingPlanQuotaWindows(quota)
          return {
            provider: runtime.variant.id,
            displayName: runtime.variant.displayName,
            // 套餐标签跟变体走（凭据 transform 已固定 zcodePlan）：Start Plan
            // 变体报 "Start Plan"（专属通道 + 专属额度），Coding Plan 变体报
            // 上游订阅的真实名称。两条额度口径互不混报。
            plan: isZCode
              ? (isStartPlan
                ? 'Start Plan'
                : credits.accounts.find(account => account.planName !== undefined)?.planName ?? 'Coding Plan')
              : undefined,
            // 三套口径，各有真源：
            // - Coding Plan：客户端同款 monitor 端点的窗口额度（5 小时 / 7 天 /
            //   工具调用）——用户要的就是这三个；拿不到时回退订阅有效性窗口。
            // - Start Plan：当日 token 池（有池子报真实 token 数，没领取时说
            //   「今日待领取」）。
            // - WorkBuddy：同币种分包求和的总积分。
            windows: isStartPlan
              ? startPlanWindows(credits.accounts)
              : quotaWindows.length > 0
                ? quotaWindows
                : isZCode ? currentPlanWindow(credits.accounts) : totalCreditsWindows(credits.accounts),
            fetchedAt: Date.now(),
          }
        },
        runtime.variant.displayName,
      ), 'dsh-any-connect: usage querier')
    }
  })
}
