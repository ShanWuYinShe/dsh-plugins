/**
 * catalog-lifecycle.ts — 目录生命周期组合入口（对外 API 不变）。
 *
 * 2026-10-08 从 478 行拆出：
 * - catalog-fingerprint.ts：内容指纹（纯函数）；
 * - catalog-refresh.ts：刷新/发布/领取快通道；
 * - catalog-timers.ts：身份 sweep 与小时刷新。
 *
 * @module dsh-any-connect/catalog-lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { WorkBuddyCredential } from './auth.js'
import type { WorkBuddyUpstreamClient } from './upstream.js'
import type { StartPlanPreviewResult } from './zcode-plan-claim.js'
import type { VariantRuntime } from './variant-runtime.js'
import { createCatalogRefresh } from './catalog-refresh.js'
import { createCatalogTimers } from './catalog-timers.js'

/** 生命周期依赖（由 index.ts 的 apply() 提供）。 */
export interface CatalogLifecycleDeps {
  ctx: Context
  /** 无自有 client 的变体（WorkBuddy 线）用的共享客户端。 */
  client: WorkBuddyUpstreamClient
  runtimes: readonly VariantRuntime[]
  /** provider → 适配器注册句柄；目录变化时靠它通知宿主。 */
  adapterHandles: Map<string, AdapterRegistrationHandle>
  /** 插件是否已进入停止流程（dispose 置位）。 */
  isStopped: () => boolean
}

/** apply() 需要的那几件事。 */
export interface CatalogLifecycle {
  refreshCatalog(runtime: VariantRuntime, reason: string, retriesLeft?: number): void
  adoptSignedOut(runtime: VariantRuntime): void
  publishCatalog(runtime: VariantRuntime): void
  claimFlipChanged(runtime: VariantRuntime): Promise<boolean>
  claimPreviewFor(runtime: VariantRuntime): (credential: WorkBuddyCredential) => Promise<StartPlanPreviewResult>
  startTimers(): void
  stopTimers(): void
}

/** 建一套目录生命周期（每插件实例一份）。 */
export function createCatalogLifecycle(deps: CatalogLifecycleDeps): CatalogLifecycle {
  const refresh = createCatalogRefresh(deps)
  const timers = createCatalogTimers({
    runtimes: deps.runtimes,
    isStopped: deps.isStopped,
    refreshCatalog: refresh.refreshCatalog,
    adoptSignedOut: refresh.adoptSignedOut,
    claimFlipChanged: refresh.claimFlipChanged,
    emptyRosterSelfHealMs: refresh.emptyRosterSelfHealMs,
  })
  return {
    refreshCatalog: refresh.refreshCatalog,
    adoptSignedOut: refresh.adoptSignedOut,
    publishCatalog: refresh.publishCatalog,
    claimFlipChanged: refresh.claimFlipChanged,
    claimPreviewFor: refresh.claimPreviewFor,
    startTimers: timers.startTimers,
    stopTimers: timers.stopTimers,
  }
}
