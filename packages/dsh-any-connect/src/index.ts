/**
 * WorkBuddy models for DeepSeek Harness. The WorkBuddy providers reuse the
 * desktop apps' sign-in. Streaming, tool calls, compaction, and permissions
 * stay Harness-owned.
 * @module dsh-any-connect
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { RegionMismatchError, WorkBuddyCredentialStore } from './auth.js'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, FALLBACK_ZCODE_MODELS, WorkBuddyCatalog } from './catalog.js'
import { FALLBACK_ZCODE_START_PLAN_MODELS } from './zcode-plan-models.js'
import type { WorkBuddyModelInfo } from './catalog.js'
import { WorkBuddyCatalogStore, credentialIdentity, workbuddyCatalogPath } from './catalog-store.js'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.js'
import { createWorkBuddyShim } from './shim.js'
import type { WorkBuddyShim } from './shim.js'
import { WorkBuddyUpstreamClient, ZCodeUpstreamClient, chatBase } from './upstream.js'
import type { WorkBuddyCredential } from './auth.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.js'
import { applyZCodePlanOverride, isNightFreeEligiblePlan } from './zcode-plan-store.js'
import { WorkBuddyProbeService } from './probe-service.js'
import { newestFirst, workbuddyProbePath, WorkBuddyProbeStore } from './probe-store.js'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.js'
import { ANYCONNECT_VERSION } from './version.js'
import { AI_VARIANT, CN_VARIANT, PROVIDER_VARIANTS, WORKBUDDY_VARIANTS, ZCODE_START_PLAN_VARIANT, ZCODE_VARIANT } from './variants.js'
import type { WorkBuddyVariant } from './variants.js'
import { registerWorkBuddyStatusRoute } from './web-status.js'
import type { StartPlanPreviewResult } from './zcode-plan-claim.js'
import { fallbackFor, variantIsStartPlan } from './variant-runtime.js'
import type { VariantRuntime } from './variant-runtime.js'
import { registerUsageQueriers } from './usage.js'
import { createCatalogLifecycle } from './catalog-lifecycle.js'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.js'

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
 * Fallback settings namespace owning the configuration card.
 *
 * The directory entry's `settingsNs` is the Loader profile entry id
 * (`ctx.fiber.entry?.options.id`); these constants only survive as the
 * fallback when no Loader hosts the plugin (bare-`Context` tests) plus the
 * stable provider-identity strings the client and tests already key on.
 */
export const WORKBUDDY_SETTINGS_NS = 'anyconnect' as SettingsNamespace

/** Fallback settings namespace owning the international variant's card. */
export const WORKBUDDY_AI_SETTINGS_NS = 'anyconnect-ai' as SettingsNamespace

/** Fallback settings namespace owning the ZCode variant's card. */
export const ZCODE_SETTINGS_NS = 'anyconnect-zcode' as SettingsNamespace

/** Plugin configuration: live volatile references committed by the Loader.
 *
 * Editable fields are declared `.volatile()` and read with `.get()`, which
 * tracks profile edits without a remount (see `loader/volatile-update`
 * below, mirroring upstream `dsh-llm-pi-ai`). The `Options` type is the
 * plain-value shape callers pass to `ctx.plugin()`; Cordis parses it through
 * this schema into the `Config` references.
 */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile: Volatile<string | undefined>
  /** Explicit WorkBuddy AI desktop auth-file path, overriding env and platform defaults. */
  authFileAI: Volatile<string | undefined>
  /** Explicit ZCode desktop auth-file path, overriding env and platform defaults. */
  authFileZCode: Volatile<string | undefined>
  // schemastery strips unknown fields, so a stale field in a
  // cordis.patch.yml is ignored rather than rejected.
}

/** Plain configuration values, before schema parsing wraps them in references. */
export type Options = {
  [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : never
}

export const Config = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)').volatile(),
  authFileAI: z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)').volatile(),
  authFileZCode: z.string().description('ZCode desktop auth file (defaults to the app\'s own location)').volatile(),
})

/** The auth-file config field a WorkBuddy variant edits, if it has one. */
const AUTH_FILE_FIELD_BY_ID = new Map<string, 'authFile' | 'authFileAI' | 'authFileZCode'>([
  [CN_VARIANT.id, 'authFile'],
  [AI_VARIANT.id, 'authFileAI'],
  // 两个 ZCode 变体读同一份桌面凭据文档（各自取用专属材料）。
  [ZCODE_VARIANT.id, 'authFileZCode'],
  [ZCODE_START_PLAN_VARIANT.id, 'authFileZCode'],
])

function configuredAuthFile(values: Options, variant: WorkBuddyVariant): string | undefined {
  const field = AUTH_FILE_FIELD_BY_ID.get(variant.id)
  return field === undefined ? undefined : values[field]
}

/**
 * Push configuration values into one variant's credential stores (no catalog
 * I/O — the caller refreshes afterwards): WorkBuddy variants repoint their
 * desktop auth-file path.
 *
 * Exported for tests: the `loader/volatile-update` path has no Loader in unit
 * tests, so the store-branching is driven directly here.
 *
 * @returns which credential source was pushed, for diagnostics.
 */
export function applyVariantConfig(
  variant: WorkBuddyVariant,
  stores: {
    credentialStore?: Pick<WorkBuddyCredentialStore, 'setDesktopPath'>
  },
  values: Options,
): 'authFile' | undefined {
  const field = AUTH_FILE_FIELD_BY_ID.get(variant.id)
  if (field !== undefined) {
    stores.credentialStore?.setDesktopPath(values[field])
    return 'authFile'
  }
  return undefined
}

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
  let stopped = false
  /** Live configuration snapshot: volatile references committed by the Loader
   * without a remount (read fresh on every use — caching the values would pin
   * the install-time document); install-time values where no Loader runs. */
  const current = (): Options => ({
    authFile: config.authFile.get(),
    authFileAI: config.authFileAI.get(),
    authFileZCode: config.authFileZCode.get(),
  })

  /** Build one variant's stores and catalog; the shim starts below. */
  function createRuntime(variant: WorkBuddyVariant): VariantRuntime {
    const catalog = new WorkBuddyCatalog(fallbackFor(variant), variant.kind)
    // Start hidden: a variant must serve no models until an account has actually
    // been adopted, so a signed-out variant is empty rather than showing a roster
    // whose models could only fail.
    catalog.setVisible(false)
    const configured = configuredAuthFile(current(), variant)

    if (variant.kind === 'zcode') {
      // Start Plan 是独立变体，走专属模型名单；两个变体的 transform 各自把
      // 自己的计划语义固定进读出的凭据（credential.zcodePlan 恒为该变体的
      // 计划）——模型路由（专属 vs 普通通道）、额度来源、夜免资格都只看这
      // 一个字段。共享同一份桌面凭据文档，互不掺用对方的材料。
      const zcodeClient = new ZCodeUpstreamClient({
        models: variant.zcodePlanMode === 'start' ? FALLBACK_ZCODE_START_PLAN_MODELS : FALLBACK_ZCODE_MODELS,
      })
      const credentialStore = new WorkBuddyCredentialStore({
        variant,
        ...configured === undefined ? {} : { desktopPath: configured },
        refresh: credential => zcodeClient.refreshToken(credential),
        onWarning: message => ctx.logger?.warn?.(message),
        transformCredential: credential =>
          applyZCodePlanOverride(credential, variant.zcodePlanMode === 'start' ? 'start-plan' : 'coding-plan'),
      })
      const catalogStore = new WorkBuddyCatalogStore({ path: workbuddyCatalogPath(variant.catalogFilename) })
      const shim = createWorkBuddyShim({ kind: 'zcode', store: credentialStore, client: zcodeClient, catalog, logger: ctx.logger })
      const runtime: VariantRuntime = {
        variant, store: credentialStore, catalog, shim,
        client: zcodeClient, credentialStore, catalogStore,
        probeStore: undefined,
        probeService: undefined,
        catalogSource: 'fallback',
        catalogFetchedAtMs: undefined,
        catalogError: undefined,
        lastIdentity: undefined,
        // 指纹来自 catalog 的构造参数（各变体的兜底名单），所以初始值不能是
        // 'hidden'——未登录时分组本就隐藏，那会让第一次 refresh 误判成"没变"
        // 而漏掉通知。见 createRuntime 里的说明。
        publishedCatalog: '',
        catalogEmpty: false,
      }
      return runtime
    }

    const credentialStore = new WorkBuddyCredentialStore({
      variant,
      ...configured === undefined ? {} : { desktopPath: configured },
      refresh: credential => client.refreshToken(credential),
      onWarning: message => ctx.logger?.warn?.(message),
    })
    const catalogStore = new WorkBuddyCatalogStore({ path: workbuddyCatalogPath(variant.catalogFilename) })
    const probeStore = new WorkBuddyProbeStore({
      pluginVersion: ANYCONNECT_VERSION,
      path: workbuddyProbePath(variant.probeFilename),
    })
    const shim = createWorkBuddyShim({ kind: 'workbuddy', store: credentialStore, client, catalog, logger: ctx.logger })
    const runtime: VariantRuntime = {
      variant, store: credentialStore, catalog, shim,
      client, credentialStore, catalogStore, probeStore,
      probeService: undefined as unknown as WorkBuddyProbeService,
      catalogSource: 'fallback',
      catalogFetchedAtMs: undefined,
      catalogError: undefined,
      lastIdentity: undefined,
      // 与 ZCode 分支同理：初始指纹必须是"绝不可能等于首次发布"的哨兵。
      publishedCatalog: '',
      catalogEmpty: false,
    }
    runtime.probeService = new WorkBuddyProbeService({
      store: probeStore,
      catalog,
      credentials: credentialStore,
      client,
      // Observations are per account: the service reads and writes its records
      // against this identity, so one account's detected levels never answer
      // for another's.
      account: () => runtime.lastIdentity,
      // 清扫的探针失败必须可见:RegionMismatchError 是用户可修复的配置错误,
      // 静默吞掉会让"为什么模型没检测"无从排查。
      onSweepError: (modelId, error) => {
        ctx.logger?.warn?.(
          `[anyconnect] background probe for ${variant.id}/${modelId} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    })
    return runtime
  }

  const runtimes = PROVIDER_VARIANTS.map(createRuntime)

  /** Per-process key authorizing probe control writes; handed to the cards. */
  const probeKey = createProbeKey()

  /**
   * 每个 provider 的适配器注册句柄（{@link AdapterRegistrationHandle}）：
   * 既是释放函数，也带着 `replace()` —— 目录变化时用它通知宿主（{@link notifyCatalogChanged}）。
   * 注册与释放在 shim 就绪回调里成对发生，这里只留"当前活着的那一个"。
   */
  const adapterHandles = new Map<string, AdapterRegistrationHandle>()

  /** 目录生命周期（拉取 / 发布 / 领取快通道 / 定时器）见 catalog-lifecycle.ts。 */
  const lifecycle = createCatalogLifecycle({
    ctx,
    client,
    runtimes,
    adapterHandles,
    isStopped: () => stopped,
  })

  /**
   * Compact probe state for one card: sweep progress and observations.
   *
   * Results read through the *same* judgement the adapter uses, rather than
   * straight from the store: a raw record can be stale in ways the adapter
   * already discounts (row changed, TTL passed, upstream since declared a set
   * that always wins) — showing one would have the card promise levels the
   * model picker does not offer.
   */
  function probeSection(runtime: VariantRuntime): WorkBuddyWebProbeSection {
    // 仅 WorkBuddy 变体携带探针服务；status 路由也只对它们启用 probe 字段。
    if (runtime.probeService === undefined) {
      return { running: false, results: [] }
    }
    const results = runtime.catalog.current().flatMap(info => {
      const record = runtime.probeService!.recordFor(info.id)
      if (record === undefined) return []
      return [{
        id: info.id,
        name: info.name,
        validation: record.validation,
        efforts: record.efforts,
        probedAt: record.probedAtMs,
      }]
    })
    return {
      running: runtime.probeService.isRunning(),
      results: newestFirst(results),
    }
  }

  function catalogSection(runtime: VariantRuntime): WorkBuddyWebCatalog {
    return {
      source: runtime.catalogSource,
      ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
      // 与 error 互斥：error 表示「没拉到、保留旧名单」，empty 表示「拉到了、就是空的」。
      ...runtime.catalogEmpty && runtime.catalogError === undefined ? { empty: true as const } : {},
      ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
    }
  }

  // Same-origin status routes backing each Plugin-configuration card; the
  // webServer service is optional (a headless profile serves no browser).
  ctx.inject(['webServer'], webCtx => {
    for (const runtime of runtimes) {
      registerWorkBuddyStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        fetchCredits: credential => runtime.client!.fetchCredits(credential as Parameters<WorkBuddyUpstreamClient['fetchCredits']>[0]),
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        // 探针区与档位检测只属于 WorkBuddy 变体。
        probe: () => probeSection(runtime),
        // 「今日 Start Plan 待领取」只对 Start Plan 变体探测：Coding Plan 变体
        // 没有账号计划可领，报一个恒为 none 的字段只会误导。
        ...variantIsStartPlan(runtime.variant) ? { fetchStartPlanClaim: lifecycle.claimPreviewFor(runtime) } : {},
        probeKey,
      })
      registerWorkBuddyProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        refresh: async () => {
          if (stopped) return { state: 'failed' as const, reason: 'plugin is stopping' }
          // 先重读凭据：用户按刷新多半因为名单看起来不对，而最常见的
          // 原因是上次拉取后才发生的登录。重注册不需要——变的是可见性，
          // 而那归核对管。
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            return {
              state: 'failed' as const,
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
            }
          }
          if (credential === undefined) {
            lifecycle.adoptSignedOut(runtime)
            return { state: 'signed-out' as const }
          }
          lifecycle.refreshCatalog(runtime, 'manual refresh')
          return { state: 'ok' as const }
        },
      }, probeKey)
    }
  })

  // Usage readout：注册 seam 与 pill 窗口助手见 usage.ts（本文件不再持有查询器实现）。
  registerUsageQueriers(ctx, runtimes, client)

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
  ctx.on('loader/volatile-update', () => {
    if (stopped) return
    for (const runtime of runtimes) {
      applyVariantConfig(runtime.variant, runtime, current())
      // 凭据变化后重拉模型目录：目录只在启动时拉一次的话，晚登录/换
      // 账号的用户会一直停在旧名单，直到插件重载。拉取失败仅告警，
      // last-known 目录照常服务。
      lifecycle.refreshCatalog(runtime, 'authFile changed')
    }
  })

  // 身份核对节拍（60s）与目录周期刷新（60min）两条定时器；两者的语义、
  // 领取快通道与空名单自愈的判据都在 catalog-lifecycle.ts。
  lifecycle.startTimers()

  // 清理必须以 Promise 形式交回 cordis：宿主与测试都在 await 卸载完成，
  // 而 fire-and-forget 的两处收尾（心跳删除、shim 关闭）会与调用方的后续
  // 动作竞态——表现为临时目录删除时 ENOTEMPTY（心跳文件刚被写/删），以及
  // 测试进程里残留的监听端口。返回 Promise 后 cordis 会等它落定。
  ctx.effect(() => async () => {
    stopped = true
    lifecycle.stopTimers()
    // close 期间 server 的 error 事件会 reject 该 promise,不捕获就是
    // unhandled rejection——Node 默认策略下会终止宿主进程,且恰发生在
    // dispose 路径。降级为告警日志。
    await Promise.all(runtimes.map(async runtime => {
      try {
        await runtime.shim.close()
      } catch (error: unknown) {
        ctx.logger?.warn?.(`dsh-any-connect: shim close failed: ${error}`)
      }
    }))
    await clearHostHeartbeat()
  })

  // 身份核对：只读 current()，身份没变就什么都不做（零上游请求）。
  for (const runtime of runtimes) {
    const { catalog, shim, variant } = runtime
    void shim.ready
      .then(() => {
        if (stopped) return

        try {
          // Constructed only once the listener holds a port: the provider's
          // models read the shim origin at construction time. WorkBuddy
          // speaks OpenAI completions through the shim.
          const adapter = createWorkBuddyAdapter({
            shim,
            catalog,
            providerId: variant.id,
            displayName: variant.displayName,
            api: variant.kind === 'zcode' ? 'anthropic-messages' : 'openai-completions',
            store: runtime.credentialStore!,
            recordFor: modelId => runtime.probeService?.recordFor(modelId),
            resolveAttachments: () => ctx.get('attachments'),
          })

          let releaseAdapter: AdapterRegistrationHandle | undefined
          let releaseDirectory: (() => void) | undefined
          try {
            releaseAdapter = ctx.llm.registerAdapter([variant.id], adapter.adapter)
            releaseDirectory = ctx.llm.registerConfigurableProviders([{
              provider: variant.id,
              displayName: variant.displayName,
              // Host directory entries point at the Loader profile entry id;
              // without a Loader (bare-Context installs/tests) fall back to
              // the plugin's own namespace for a stable, testable identity.
              settingsNs: ctx.fiber.entry?.options.id ?? variant.settingsNs,
              settingsPath: [],
              declared: false,
            }])
          } finally {
            if (releaseAdapter === undefined || releaseDirectory === undefined) {
              // Registration threw; release whichever half landed.
              releaseAdapter?.()
              releaseDirectory?.()
            }
          }
          // 注册成功：记下句柄，目录变化时靠它通知宿主（见 notifyCatalogChanged）。
          // 与下面的释放严格成对——不记的话就是一条挂在已释放注册上的 replace。
          adapterHandles.set(variant.id, releaseAdapter)
          try {
            ctx.effect(() => () => {
              adapterHandles.delete(variant.id)
              releaseAdapter?.()
              releaseDirectory?.()
            })
          } catch {
            // The plugin was disposed during registration; release immediately —
            // the plugin-level disposer already closed the shim.
            adapterHandles.delete(variant.id)
            releaseAdapter?.()
            releaseDirectory?.()
          }
          // 注册本身就会发布 llm/adapters-updated，所以这一次通知不是多余的：
          // 客户端在启动到注册之间可能已打开过页面，缓存里存的是空目录。
          lifecycle.publishCatalog(runtime)

          // The host bundle is live: write a heartbeat so the status CLI can
          // report host health without a browser. Cleared on disposal; a stale
          // heartbeat after a crash is detected by PID in the reader.
          void writeHostHeartbeat()
        } catch (error: unknown) {
          ctx.logger.error('dsh-any-connect: provider registration failed', error)
          return
        }

        lifecycle.refreshCatalog(runtime, 'startup')
      })
      .catch((error: unknown) => {
        ctx.logger.error('dsh-any-connect: loopback endpoint failed to start; provider not registered', error)
      })
  }
}
