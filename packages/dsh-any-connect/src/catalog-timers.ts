/**
 * catalog-timers.ts — 两条定时器：60s 身份 sweep 与每小时目录刷新。
 *
 * 2026-10-08 从 catalog-lifecycle.ts 拆出：sweep 含 Start Plan 领取快通道与空名单
 * 自愈，小时定时器只管周期重拉；函数体逐字保留。
 *
 * @module dsh-any-connect/catalog-timers
 */

import { RegionMismatchError } from './auth.js'
import { credentialIdentity } from './catalog-store.js'
import { variantIsStartPlan } from './variant-runtime.js'
import { isZCodeOffpeak } from './upstream.js'
import type { VariantRuntime } from './variant-runtime.js'

/** 定时器依赖：刷新链路的入口由 catalog-lifecycle 注入。 */
export interface CatalogTimersDeps {
  runtimes: readonly VariantRuntime[]
  isStopped: () => boolean
  refreshCatalog(runtime: VariantRuntime, reason: string): void
  adoptSignedOut(runtime: VariantRuntime): void
  claimFlipChanged(runtime: VariantRuntime): Promise<boolean>
  emptyRosterSelfHealMs: number
}

/** apply() 启动/停止两条定时器。 */
export interface CatalogTimers {
  startTimers(): void
  stopTimers(): void
}

export function createCatalogTimers(deps: CatalogTimersDeps): CatalogTimers {
  const { runtimes, isStopped, refreshCatalog, adoptSignedOut, claimFlipChanged, emptyRosterSelfHealMs: EMPTY_ROSTER_SELF_HEAL_MS } = deps
  let sweep: ReturnType<typeof setInterval> | undefined
  let catalogTimer: ReturnType<typeof setInterval> | undefined

/**
 * 身份核对节拍：启动/authFile 变更只覆盖"当时"的登录态，之后用户在桌面
 * 端登录/登出不会自动触达这里。每 60s（与卡片轮询同频）用一次廉价的
 * `store.current()` 文件读取核对身份，变了才走完整拉取——稳态零上游请求，
 * 登录态翻转最多延迟一拍即现形。unref，不拖住进程退出。
 */
const IDENTITY_SWEEP_MS = 60_000

/**
 * 目录周期刷新节拍：上游目录会漂移（促销上下线、倍率与声明档位调整、新
 * 模型），启动只拉一次的话长驻宿主会一直服务旧名单。每小时对 WorkBuddy
 * 变体重拉一次（一次免费的 catalog GET，无积分消耗）；拉取失败走既有重试，
 * 耗尽后等下个周期自然再试——「启动时网络不好就永远停在 fallback」从此
 * 不存在。unref，不拖住进程退出。
 */
const CATALOG_REFRESH_INTERVAL_MS = 60 * 60_000

  /** 启动身份 sweep 与目录周期刷新（两者都 unref，不拖住进程退出）。 */
  function startTimers(): void {
  // 身份与时段核对：只读 current()，身份没变就什么都不做（零上游请求）。
  // 时段交界处（夜间免费 23:00 / 09:00）自动重新同步 ZCode 目录。
  // 用 unref 的 interval，vitest 假时钟下 advanceTimers 会触发它——回调内
  // 无身份变化时不触网，现有重试计数测试不受影响。区域错配在这里静默隐藏
  // （原因已由 status 报给卡片），不每 60s 打一条告警。
  let lastOffpeak = isZCodeOffpeak()
  sweep = setInterval(() => {
    if (isStopped()) return
    const currentOffpeak = isZCodeOffpeak()
    const offpeakChanged = currentOffpeak !== lastOffpeak
    lastOffpeak = currentOffpeak

    for (const runtime of runtimes) {
      void (async () => {
        try {
          const signedIn = await runtime.store.current()
          const identity = signedIn === undefined
            ? undefined
            : credentialIdentity(signedIn as unknown as Parameters<typeof credentialIdentity>[0])
          const shouldRefresh = identity !== runtime.lastIdentity || (offpeakChanged && runtime.variant.kind === 'zcode')
          if (shouldRefresh && !isStopped()) {
            refreshCatalog(runtime, offpeakChanged ? 'offpeak boundary crossed' : 'identity sweep')
            return
          }
          // Start Plan「领取后恢复」快通道。见 claimFlipRefreshes。
          if (!isStopped() && await claimFlipChanged(runtime)) {
            refreshCatalog(runtime, 'start-plan claim flipped')
          } else if (!isStopped() && variantIsStartPlan(runtime.variant)
            && runtime.catalog.current().length === 0
            && runtime.catalogFetchedAtMs !== undefined
            && Date.now() - runtime.catalogFetchedAtMs >= EMPTY_ROSTER_SELF_HEAL_MS) {
            // 空名单自愈：领取探测一直 none（不是刚领取），但距上次拉取已超过
            // 5 分钟——上游偶尔会间歇性地答一个空活动清单（2026-10-07 实测：
            // catalog 拉得 live/empty 的同一时刻，直调同端点却有 active 活动
            // 与模型授权；余额也正常）。空名单按小时刷新兜底太久，超过阈值
            // 就再试一拍；拉完（无论结果）fetchedAtMs 都会前移，不会打环。
            refreshCatalog(runtime, 'start-plan empty roster self-heal')
          }
        } catch (error: unknown) {
          if (error instanceof RegionMismatchError) {
            if (!isStopped()) adoptSignedOut(runtime)
            return
          }
          // 核对读失败（文件瞬态不可读）不惊动：下次节拍再看。
        }
      })()
    }
  }, IDENTITY_SWEEP_MS)
  sweep.unref()

  // 目录周期刷新：上游名单漂移（促销/倍率/档位/新模型）不再依赖用户手点。
  // refreshCatalog 内部先探登录态：未登录时等价于一次身份核对，无上游请求。
  catalogTimer = setInterval(() => {
    if (isStopped()) return
    for (const runtime of runtimes) {
      refreshCatalog(runtime, 'scheduled refresh')
    }
  }, CATALOG_REFRESH_INTERVAL_MS)
  catalogTimer.unref()
  }

  /** 停掉两条定时器（dispose 时调用；可重复调用）。 */
  function stopTimers(): void {
    if (sweep !== undefined) clearInterval(sweep)
    if (catalogTimer !== undefined) clearInterval(catalogTimer)
    sweep = undefined
    catalogTimer = undefined
  }

  return { startTimers, stopTimers }
}
