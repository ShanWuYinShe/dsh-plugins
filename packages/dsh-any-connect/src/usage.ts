/**
 * usage.ts — provider-usage 的注册 seam 与 composer dock 的额度窗口助手。
 *
 * 2026-10-08 从 index.ts 提出：查询器注册与 pill 窗口构造（WorkBuddy 总积分 /
 * ZCode 当前套餐 / Start Plan 池子 / Coding Plan 5 小时与 7 天窗口）是一件事，
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
import type { RateLimitLedger } from './rate-limit.js'
import { variantIsStartPlan } from './variant-runtime.js'
import type { VariantRuntime } from './variant-runtime.js'
import type { CreditLedgerSummary } from './credit-ledger.js'
import type { WorkBuddyCredential } from './auth.js'
import type { WorkBuddyCreditAccount, ZCodeUpstreamClient } from './upstream.js'

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
    /**
     * 当前观测到的上游限流（rate-limit.ts 的台账读数）。只在「查询器真的看到过
     * 429」时存在——额度窗口说「还剩多少」，这个说「通道现在收不收请求」，
     * 两件事互不替代：订阅制 coding plan 常常是额度还有、但被并发限流。
     */
    rateLimit?: {
      blockedAt: number
      lastSeenAt: number
      resetAt?: number
      status: number
      model?: string
      hits: number
    }
  }>, displayName?: string): () => void
}

/**
 * pill 用总窗口：同币种分包求和为一个窗口（明细在配置页卡片里看）。
 * 全耗尽返回 []（pill 渲染无额度态）——与之前“过滤耗尽包”语义一致，
 * 只是行数永远 ≤1。跨币种/跨周期的窗口绝不在此合并：其它 provider 的
 * 窗口各有其语义，这里的 accounts 永远是同口径 credit 点数。
 *
 * WorkBuddy 的额度是「裂变包」制（每天发新包、旧包到期整包消失），剩余总额
 * 每天双向跳动，单看读不出今天花了多少——台账（credit-ledger）有今日样本时
 * 追加一条「今日已用」窗口（无 limit 不画进度条），展开 pill 一眼看到今天的
 * 消耗；折叠态仍显示总计剩余（windows[0] 语义不变）。
 *
 * Exported for tests: counted directly without booting the plugin.
 */
export function totalCreditsWindows(
  accounts: readonly WorkBuddyCreditAccount[],
  todaySummary?: CreditLedgerSummary,
): Array<{
  id: string
  label: string
  remain: number
  unit: string
  limit?: number
}> {
  const live = accounts.filter(account => account.remain > 0)
  // 全部耗尽**不是**「没有额度可报」，是「额度用完了」——两者在 pill 上是
  // 两句完全不同的话。返回空窗口会被 provider-usage 渲染成「该 provider 不上报
  // 额度」（noWindows），用户据此以为查询功能坏了；这里如实报一条 remain:0 的
  // 窗口：进度条空、圆点红、文案是「0 credits 剩余」。
  // 只有「上游一个包都没给」才算真的无可报（见下方 accounts.length 判定）。
  if (live.length === 0) {
    if (accounts.length === 0) return []
    return [{
      id: 'total',
      label: '总计',
      remain: 0,
      unit: 'credits',
    }]
  }
  const remain = live.reduce((sum, account) => sum + account.remain, 0)
  const limit = live.reduce((sum, account) => sum + (account.size > 0 ? account.size : 0), 0)
  const windows: Array<{
    id: string
    label: string
    remain: number
    unit: string
    limit?: number
  }> = [{
    id: 'total',
    label: '总计',
    remain,
    unit: 'credits',
    ...limit > 0 ? { limit } : {},
  }]
  if (todaySummary !== undefined) {
    windows.push({
      id: 'today',
      label: '今日已用',
      remain: todaySummary.today.consumed,
      unit: 'credits',
    })
  }
  return windows
}

/**
 * ZCode 当前套餐窗口：只取首个仍有剩余额度（无则取第一个），与配置页卡片
 * 的 zcodePlan 取法一致——pill 与卡片看到的是同一个“当前套餐”，而不是
 * 一摞计划名。
 *
 * Start Plan 的 token 池数字是真实的（billing/balance 的 remain/size），
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
  // token 计数池（Start Plan，无论当日还是多日有效期）画 remain/size 进度条。
  // remain = 0（用完了）照样带数字——红色空条正是「用完了」的正确语义。
  // WorkBuddy 的积分制账户不带 unit，走下面的「有效」窗口。
  if (current.unit === 'tokens' && current.size > 0) {
    return [{
      id: 'plan',
      label,
      remain: current.remain,
      limit: current.size,
      unit: current.unit,
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
 * Start Plan 的 pill 窗口：**每个 token 池一条**（2026-10-24 起上游按模型分池，
 * 池子互不通用，每条带真实 remain/limit，当日与多日有效期都画进度条）；今天还没
 * 领取或尚未发放时**如实说「今日待领取」**，而不是让 pill 落到通用的「该 provider
 * 不上报额度」——那会让用户以为额度功能坏了，而且额度接口本身是通的
 * （billing/balance 返回空 balances 才是事实）。
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
  // 2026-10-24 实测（"ZCode 1024 Dev Day" 活动）：上游把一个活动按模型拆成多份
  // entitlement，balances 里每个模型一个 bucket（capabilities 绑定各自模型，池子
  // 互不通用）。每个 token 池一条窗口——currentPlanWindow 的"只取第一个有余额
  // 的池"会把其余池子整个吞掉，而把互不通用的池求和又谎报了一个"哪个模型都能用"
  // 的总额度，两者都让用户按不存在的额度做决定。remain=0 的池照样显示（红色空条
  // 正是"这个模型用完了"的正确语义）。id 用池名派生保证窗口内唯一（UsageWindow.id
  // 是 React 列表 key）；上游理论上不该出现重名池，撞名时追加序号兜底。
  const pools = accounts.filter(account => account.unit === 'tokens' && account.size > 0)
  if (pools.length > 0) {
    const seen = new Map<string, number>()
    return pools.map(account => {
      const label = account.packageName.replace(/\s*\((?:有效|VALID|EXPIRED|已过期)\)$/i, '')
      const base = `plan:${label.toLowerCase()}`
      const nth = (seen.get(base) ?? 0) + 1
      seen.set(base, nth)
      return {
        id: nth === 1 ? base : `${base}:${nth}`,
        label,
        remain: account.remain,
        limit: account.size,
        unit: 'tokens',
        ...account.expiredAt === undefined ? {} : { resetsAt: account.expiredAt },
      }
    })
  }
  // 拿不到可解析的 token 池：维持旧口径（畸形池走 currentPlanWindow 的防御分支；
  // 什么都没有时报「今日待领取」——billing/balance 通着但今天还没发池子）。
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
 */
export function registerUsageQueriers(
  ctx: Context,
  runtimes: readonly VariantRuntime[],
  rateLimits?: RateLimitLedger,
): void {
  ctx.inject(['providerUsage'], (usageCtx: Context) => {
    const usage = usageCtx.get('providerUsage') as ProviderUsageRegistryLike | undefined
    if (usage === undefined) return
    for (const runtime of runtimes) {
      usageCtx.effect(() => usage.register(
        runtime.variant.id,
        async context => {
          const credential = await runtime.store.resolve()
          if (context.signal?.aborted === true) throw context.signal.reason ?? new Error('aborted')
          const credits = await runtime.client.fetchCredits(credential)
          const isZCode = runtime.variant.kind === 'zcode'
          const isOpenCode = runtime.variant.kind === 'opencode'
          const isStartPlan = variantIsStartPlan(runtime.variant)
          const isWorkBuddy = runtime.variant.kind === 'workbuddy'
          // 今日消耗台账（credit-ledger，仅积分制变体）：pill 每次成功拉到积分
          // 记一次观测，相邻样本差分出「今日已用」。台账是统计附属品，任何故障
          // 只降级为「无今日窗口」，绝不拖垮 pill 查询。
          let todaySummary: CreditLedgerSummary | undefined
          if (isWorkBuddy && runtime.ledger !== undefined) {
            try {
              await runtime.ledger.record(runtime.variant.id, credits.total)
              todaySummary = await runtime.ledger.summary(runtime.variant.id)
            } catch {
              todaySummary = undefined
            }
          }
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
            // 上游订阅的真实名称。两条额度口径互不混报。OpenCode 报 Free Tier。
            plan: isZCode
              ? (isStartPlan
                ? 'Start Plan'
                : credits.accounts.find(account => account.planName !== undefined)?.planName ?? 'Coding Plan')
              : (isOpenCode ? 'Free Tier' : undefined),
            // 四套口径，各有真源：
            // - OpenCode Free：官方免密通道，直接标示「官方免费」，不显示虚假点数。
            // - Coding Plan：客户端同款 monitor 端点的窗口额度（5 小时 / 7 天 /
            //   工具调用）——用户要的就是这三个；拿不到时回退订阅有效性窗口。
            // - Start Plan：token 池（有池子报真实 token 数，没领取时说
            //   「今日待领取」）。
            // - WorkBuddy：同币种分包求和的总积分。
            windows: isOpenCode
              ? [{ id: 'plan', label: 'OpenCode Free', unit: '官方免费' }]
              : isStartPlan
                ? startPlanWindows(credits.accounts)
                : quotaWindows.length > 0
                  ? quotaWindows
                  : isZCode
                    ? currentPlanWindow(credits.accounts)
                    : totalCreditsWindows(credits.accounts, todaySummary),
            fetchedAt: Date.now(),
            // 限流读数与额度窗口并列上报：额度是「还剩多少」，限流是「现在能不能发」。
            // 台账里没有活跃观测就整段缺席（= 当前没被限），不报一个空对象让
            // 界面去猜。
            ...(() => {
              const active = rateLimits?.activeFor(runtime.variant.id)
              if (active === undefined) return {}
              return {
                rateLimit: {
                  blockedAt: active.blockedAtMs,
                  lastSeenAt: active.lastSeenAtMs,
                  ...active.resetAtMs === undefined ? {} : { resetAt: active.resetAtMs },
                  status: active.status,
                  ...active.model === undefined ? {} : { model: active.model },
                  hits: active.hits,
                },
              }
            })(),
          }
        },
        runtime.variant.displayName,
      ), 'dsh-any-connect: usage querier')
    }
  })
}
