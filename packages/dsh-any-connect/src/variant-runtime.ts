/**
 * variant-runtime.ts — 变体运行时的类型与共用助手。
 *
 * 2026-10-08 从 index.ts 提出：这些类型与小助手被「目录刷新」「usage 注册」
 * 「路由注册」三块共用，留在入口文件里会让每一次拆分都产生循环依赖。
 * 本模块只依赖 variants / catalog / upstream 的类型与常量，不碰 ctx，
 * 因此可以被任意一侧安全 import。
 *
 * @module dsh-any-connect/variant-runtime
 */

import {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_ZCODE_MODELS,
} from './catalog.js'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.js'
import { FALLBACK_ZCODE_START_PLAN_MODELS } from './zcode-plan-models.js'
import { AI_VARIANT, CN_VARIANT, ZCODE_START_PLAN_VARIANT, ZCODE_VARIANT } from './variants.js'
import type { WorkBuddyVariant } from './variants.js'
import type { WorkBuddyAuthStatus, WorkBuddyCredentialStore } from './auth.js'
import type { WorkBuddyCatalogStore } from './catalog-store.js'
import type { WorkBuddyProbeService } from './probe-service.js'
import type { WorkBuddyProbeStore } from './probe-store.js'
import type { WorkBuddyShim } from './shim.js'
import type { WorkBuddyWebCatalog } from './status-paths.js'
import type { WorkBuddyUpstreamClient, ZCodeUpstreamClient } from './upstream.js'

/**
 * Structural minimum every variant's credential store satisfies. Credentials
 * travel opaquely (WorkBuddy OAuth fields) — only the WorkBuddy paths ever
 * look inside.
 */
interface RuntimeStore {
  current(): Promise<unknown>
  resolve(): Promise<unknown>
  status(): Promise<WorkBuddyAuthStatus>
  logout(): Promise<void>
}

/** One variant's live runtime: credential store, catalog, and source state. */
export interface VariantRuntime {
  variant: WorkBuddyVariant
  store: RuntimeStore
  catalog: WorkBuddyCatalog
  shim: WorkBuddyShim
  catalogSource: WorkBuddyWebCatalog['source']
  catalogFetchedAtMs: number | undefined
  catalogError: string | undefined
  /**
   * 最近一次 live 拉取**成功但零模型**（Start Plan 今日未领取/活动已过期）。
   *
   * 空名单本身是有效观测，但它与「插件坏了」在卡片上原本无法区分——两者都是
   * source=live + 刚拉取 + 0 个模型。这个标记让卡片能如实说明原因（见
   * {@link WorkBuddyWebCatalog.empty}）。
   */
  catalogEmpty: boolean
  /** 上次发布过目录的账号（`uid:enterpriseId`），或 undefined。 */
  lastIdentity: string | undefined
  /**
   * 该变体上一次通知给宿主的"已发布目录"指纹。
   *
   * 只在目录内容**真的变了**时才通知（见 `publishCatalog`）：宿主每小时
   * 会重拉一次目录，多数时候名单一模一样，无条件通知会让每个打开的聊天页白
   * 重拉一次目录、白重渲染一次模型选择框。
   *
   * 初始值无关紧要：第一轮 refresh 一定经过一次 `publishCatalog`。
   */
  publishedCatalog: string
  /** WorkBuddy-only parts: live catalog lifecycle, refresh, probe. */
  client?: WorkBuddyUpstreamClient | ZCodeUpstreamClient
  credentialStore?: WorkBuddyCredentialStore
  catalogStore?: WorkBuddyCatalogStore
  probeStore?: WorkBuddyProbeStore
  probeService?: WorkBuddyProbeService
}

/** The static catalog a variant serves before its first successful fetch. */
const FALLBACK_BY_ID = new Map<string, readonly WorkBuddyModelInfo[]>([
  [CN_VARIANT.id, FALLBACK_WORKBUDDY_MODELS],
  [AI_VARIANT.id, FALLBACK_WORKBUDDY_AI_MODELS],
  [ZCODE_VARIANT.id, FALLBACK_ZCODE_MODELS],
  [ZCODE_START_PLAN_VARIANT.id, FALLBACK_ZCODE_START_PLAN_MODELS],
])

/** 变体的编译期兜底目录（首次成功拉取前 / saved 与 fallback 都不可用时）。 */
export function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return FALLBACK_BY_ID.get(variant.id) ?? FALLBACK_WORKBUDDY_MODELS
}

/**
 * 是否是 ZCode Start Plan 变体。
 *
 * 判据取 `zcodePlanMode === 'start'`（变体自带的语义），而不是比对 id 字符串：
 * 计划语义在 `variants.ts` 里就是这一个字段，照它判定才不会被将来重命名 id
 * 悄悄改掉行为。Start Plan 是唯一有"每日领取"这回事的变体。
 */
export function variantIsStartPlan(variant: WorkBuddyVariant): boolean {
  return variant.kind === 'zcode' && variant.zcodePlanMode === 'start'
}
