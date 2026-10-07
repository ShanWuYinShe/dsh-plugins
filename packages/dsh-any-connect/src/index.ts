/**
 * WorkBuddy models for DeepSeek Harness. The WorkBuddy providers reuse the
 * desktop apps' sign-in. Streaming, tool calls, compaction, and permissions
 * stay Harness-owned.
 * @module dsh-any-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyUpstreamClient } from './upstream.js'
import { registerUsageQueriers } from './usage.js'
import { createVariantRuntimeSet } from './runtime.js'
import { Config } from './config.js'
import type { Options } from './config.js'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.js'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.js'
export {
  FALLBACK_WORKBUDDY_AI_MODELS,
  FALLBACK_WORKBUDDY_MODELS,
  FALLBACK_ZCODE_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.js'
export {
  FALLBACK_ZCODE_START_PLAN_MODELS,
  isStartPlanActivityActive,
  startPlanModelInfo,
  startPlanModelsFromEntitlements,
  type StartPlanActivity,
  type StartPlanEntitlement,
  type StartPlanEntitlements,
} from './zcode-plan-models.js'
export {
  CAPTCHA_FAILED_CODE,
  buildClaimBody,
  buildClaimHeaders,
  buildPreviewHeaders,
  buildPreviewUrl,
  claimStartPlan,
  parseClaimResponse,
  parsePreviewBody,
  previewStartPlan,
  probeAndClaimStartPlan,
  type StartPlanClaimCredential,
  type StartPlanClaimResult,
  type StartPlanPlatformInfo,
  type StartPlanPreviewItem,
  type StartPlanPreviewResult,
} from './zcode-plan-claim.js'
export {
  prepareStartPlanBody,
  withStartPlanPrefix,
  hasStartPlanPrefix,
  ZCODE_CLIENT_IDENTITY,
  ZCODE_CLIENT_PREFIX,
  ZCODE_CLIENT_PREFIX_LENGTH,
  type AnthropicTextBlock,
} from './zcode-plan-prompt.js'
export {
  WorkBuddyCatalogStore,
  WORKBUDDY_CATALOG_FILENAME,
  credentialIdentity,
  workbuddyCatalogPath,
  type SavedWorkBuddyCatalog,
} from './catalog-store.js'
export {
  decryptZCodeEncryptedKey,
  defaultDesktopAuthCandidates,
  defaultZCodeDesktopCandidates,
  desktopAuthCandidatesFor,
  parseWorkBuddyAuth,
  parseZCodeAuth,
  parseZCodePlanSelection,
  RegionMismatchError,
  selectZCodeAccountKey,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type DecryptZCodeKeyOptions,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.js'
export {
  applyZCodePlanOverride,
  effectiveZCodePlan,
  isNightFreeEligiblePlan,
} from './zcode-plan-store.js'
export {
  AI_VARIANT,
  CN_VARIANT,
  PROVIDER_VARIANTS,
  variantFor,
  WORKBUDDY_VARIANTS,
  ZCODE_VARIANT,
  type VariantKind,
  type WorkBuddyVariant,
} from './variants.js'
export {
  FALLBACK_APP_VERSION,
  WORKBUDDY_APP_VERSION_FILENAME,
  appUserAgent,
  appVersionPath,
  installedAppVersion,
  readBundleVersion,
  resolveAppVersion,
  validAppVersion,
  type AppVersionInfo,
  type WorkBuddyAppVersionSource,
} from './app-version.js'
export {
  PROBE_EFFORT_CANDIDATES,
  PROBE_MAX_TOKENS,
  PROBE_PROMPT,
  PROBE_REQUEST_TIMEOUT_MS,
  probeModel,
  randomSentinel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
  type SentinelFactory,
} from './probe.js'
export {
  newestFirst,
  fingerprintModel,
  workbuddyProbePath,
  WORKBUDDY_AI_PROBE_FILENAME,
  WORKBUDDY_PROBE_FILENAME,
  WorkBuddyProbeStore,
  type WorkBuddyProbeRecord,
  type WorkBuddyProbeValidation,
} from './probe-store.js'
export { WorkBuddyProbeService, type WorkBuddyProbeStatus } from './probe-service.js'
export {
  createProbeKey,
  registerWorkBuddyProbeRoute,
  workBuddyProbeHandler,
  WORKBUDDY_AI_PROBE_PATH,
  WORKBUDDY_PROBE_PATH,
} from './probe-route.js'
export {
  chatBase,
  classifyUpstreamError,
  modelWithCurrentPromotion,
  normalizeCredits,
  prepareAnthropicBody,
  prepareChatBody,
  prepareInternationalChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  ZCodeUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyPromotion,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
  type ZCodeUpstreamClientOptions,
} from './upstream.js'
// pill 窗口助手（provider-usage 注册 seam 的同一模块）；CLI 也直接从这里取。
export { currentPlanWindow, startPlanWindows, totalCreditsWindows } from './usage.js'
export { catalogFingerprint } from './catalog-lifecycle.js'
export { Config, WORKBUDDY_SETTINGS_NS, WORKBUDDY_AI_SETTINGS_NS, ZCODE_SETTINGS_NS } from './config.js'
export type { Options } from './config.js'
export { applyVariantConfig } from './variant-runtime.js'
export {
  parseZCodeApiKey,
  solveClientRequestProofOfWork,
  ZCodeClientSigner,
  type ZCodeParsedKey,
} from './zcode-signer.js'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.js'

/** Stable Cordis plugin name. */
export const name = 'llm-anyconnect'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Start all providers: their loopback endpoints, the `workbuddy` and
 * `workbuddy-ai` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  /** Live configuration snapshot: volatile references committed by the Loader
   * without a remount (read fresh on every use — caching the values would pin
   * the install-time document); install-time values where no Loader runs. */
  const current = (): Options => ({
    authFile: config.authFile.get(),
    authFileAI: config.authFileAI.get(),
    authFileZCode: config.authFileZCode.get(),
  })

  // 变体运行时（构造 / 路由 / 目录生命周期 / 定时器 / 适配器注册）见 runtime.ts。
  const variants = createVariantRuntimeSet({ ctx, client, current })

  // Usage readout：注册 seam 与 pill 窗口助手见 usage.ts（本文件不再持有查询器实现）。
  registerUsageQueriers(ctx, variants.runtimes, client)

  // This plugin ships its own configuration cards: opt out of the host's
  // auto-generated settings page (mirroring upstream `dsh-llm-pi-ai`). The
  // inject waits for a settings service to exist — without one the plugin
  // still serves its models, as before.
  ctx.inject(['settings'], (child: Context) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // The host commits profile edits into the volatile references without a
  // remount and dispatches `loader/volatile-update` to this fiber (values are
  // already committed when it fires). Re-read the configuration and push it
  // into every variant's stores, then re-resolve each catalog: an unchanged
  // variant re-resolves to the same value and its refresh is a cheap identity
  // check, so no per-field diffing is needed. Without a Loader the
  // configuration is install-time static and this never fires.
  ctx.on('loader/volatile-update', () => variants.applyConfiguredAuthFiles())

  // 清理必须以 Promise 形式交回 cordis：宿主与测试都在 await 卸载完成，
  // 而 fire-and-forget 的两处收尾（心跳删除、shim 关闭）会与调用方的后续
  // 动作竞态——表现为临时目录删除时 ENOTEMPTY（心跳文件刚被写/删），以及
  // 测试进程里残留的监听端口。返回 Promise 后 cordis 会等它落定。
  ctx.effect(() => () => variants.dispose())

  // 两条定时器与适配器注册（shim 就绪后逐个注册）见 runtime.ts 的 start()。
  variants.start()
}
