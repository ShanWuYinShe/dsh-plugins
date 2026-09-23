/**
 * WorkBuddy models for DeepSeek Harness. The WorkBuddy providers reuse the
 * desktop apps' sign-in. Streaming, tool calls, compaction, and permissions
 * stay Harness-owned.
 * @module dsh-any-connect
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { RegionMismatchError, WorkBuddyCredentialStore } from './auth.js'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, FALLBACK_ZCODE_MODELS, WorkBuddyCatalog } from './catalog.js'
import type { WorkBuddyModelInfo } from './catalog.js'
import { WorkBuddyCatalogStore, credentialIdentity, workbuddyCatalogPath } from './catalog-store.js'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.js'
import { createWorkBuddyShim } from './shim.js'
import type { WorkBuddyShim } from './shim.js'
import { WorkBuddyUpstreamClient, ZCodeUpstreamClient, chatBase } from './upstream.js'
import type { WorkBuddyCredential } from './auth.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.js'
import { WorkBuddyProbeService } from './probe-service.js'
import { newestFirst, workbuddyProbePath, WorkBuddyProbeStore } from './probe-store.js'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.js'
import { ANYCONNECT_VERSION } from './version.js'
import { AI_VARIANT, CN_VARIANT, PROVIDER_VARIANTS, WORKBUDDY_VARIANTS, ZCODE_VARIANT } from './variants.js'
import type { WorkBuddyVariant } from './variants.js'
import { registerWorkBuddyStatusRoute } from './web-status.js'
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
  WorkBuddyCatalogStore,
  WORKBUDDY_CATALOG_FILENAME,
  credentialIdentity,
  workbuddyCatalogPath,
  type SavedWorkBuddyCatalog,
} from './catalog-store.js'
export {
  decryptZCodeEncryptedKey,
  defaultDesktopAuthCandidates,
  desktopAuthCandidatesFor,
  parseWorkBuddyAuth,
  parseZCodeAuth,
  RegionMismatchError,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.js'
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

/** 目录拉取失败后的延迟重试：最多再试 2 次、间隔 60s（暂态故障自愈，耗尽即停）。 */
const CATALOG_REFRESH_RETRIES = 2
const CATALOG_REFRESH_RETRY_MS = 60_000

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

/**
 * Structural minimum every variant's credential store satisfies. Credentials
 * travel opaquely (WorkBuddy OAuth fields) — only the WorkBuddy paths ever
 * look inside.
 */
interface RuntimeStore {
  current(): Promise<unknown>
  resolve(): Promise<unknown>
  status(): Promise<import('./auth.js').WorkBuddyAuthStatus>
  logout(): Promise<void>
}

/** One variant's live runtime: credential store, catalog, and source state. */
interface VariantRuntime {
  variant: WorkBuddyVariant
  store: RuntimeStore
  catalog: WorkBuddyCatalog
  shim: WorkBuddyShim
  catalogSource: WorkBuddyWebCatalog['source']
  catalogFetchedAtMs: number | undefined
  catalogError: string | undefined
  /** 上次发布过目录的账号（`uid:enterpriseId`），或 undefined。 */
  lastIdentity: string | undefined
  /** WorkBuddy-only parts: live catalog lifecycle, refresh, probe. */
  client?: WorkBuddyUpstreamClient | ZCodeUpstreamClient
  credentialStore?: WorkBuddyCredentialStore
  catalogStore?: WorkBuddyCatalogStore
  probeStore?: WorkBuddyProbeStore
  probeService?: WorkBuddyProbeService
}

/**
 * The slice of @chaoset/provider-usage's registry this plugin calls.
 *
 * Declared structurally instead of imported: the two packages install
 * independently, and only the provider-usage owner should have to change when
 * its registry surface moves. If that surface changes, this is the mirror to
 * update — the host route and the browser pill both come from the other side.
 */
interface ProviderUsageRegistryLike {
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

/** The static catalog a variant serves before its first successful fetch. */
const FALLBACK_BY_ID = new Map<string, readonly WorkBuddyModelInfo[]>([
  [CN_VARIANT.id, FALLBACK_WORKBUDDY_MODELS],
  [AI_VARIANT.id, FALLBACK_WORKBUDDY_AI_MODELS],
  [ZCODE_VARIANT.id, FALLBACK_ZCODE_MODELS],
])

function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return FALLBACK_BY_ID.get(variant.id) ?? FALLBACK_WORKBUDDY_MODELS
}

/** The auth-file config field a WorkBuddy variant edits, if it has one. */
const AUTH_FILE_FIELD_BY_ID = new Map<string, 'authFile' | 'authFileAI' | 'authFileZCode'>([
  [CN_VARIANT.id, 'authFile'],
  [AI_VARIANT.id, 'authFileAI'],
  [ZCODE_VARIANT.id, 'authFileZCode'],
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
    const catalog = new WorkBuddyCatalog(fallbackFor(variant))
    // Start hidden: a variant must serve no models until an account has actually
    // been adopted, so a signed-out variant is empty rather than showing a roster
    // whose models could only fail.
    catalog.setVisible(false)
    const configured = configuredAuthFile(current(), variant)

    if (variant.kind === 'zcode') {
      const zcodeClient = new ZCodeUpstreamClient({ models: FALLBACK_ZCODE_MODELS })
      const credentialStore = new WorkBuddyCredentialStore({
        variant,
        ...configured === undefined ? {} : { desktopPath: configured },
        refresh: credential => zcodeClient.refreshToken(credential),
        onWarning: message => ctx.logger?.warn?.(message),
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
    })
    return runtime
  }

  const runtimes = PROVIDER_VARIANTS.map(createRuntime)

  /** Per-process key authorizing probe control writes; handed to the cards. */
  const probeKey = createProbeKey()

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
      ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
    }
  }

  /** 无可用凭据：分组隐藏（空目录），而不是展示点选必错的兜底名单。
   * 行保留 fallback 内容——切回可见时无需重拉。曾登录过的账号离开时，其
   * 探针记录一并清除（与上游一致：不能让新账号继承旧账号的检测档位）。 */
  function adoptSignedOut(runtime: VariantRuntime): void {
    if (runtime.lastIdentity !== undefined) runtime.probeStore?.clear()
    runtime.lastIdentity = undefined
    runtime.catalog.set(fallbackFor(runtime.variant))
    runtime.catalog.setVisible(false)
    runtime.catalogSource = 'fallback'
    runtime.catalogFetchedAtMs = undefined
    runtime.catalogError = undefined
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
            adoptSignedOut(runtime)
            return { state: 'signed-out' as const }
          }
          refreshCatalog(runtime, 'manual refresh')
          return { state: 'ok' as const }
        },
      }, probeKey)
    }
  })

  // Usage readout: this plugin owns the WorkBuddy routes and already holds the
  // credential store that reads the desktop app's sign-in, so it is the right
  // place to answer "how much credit is left" — the provider-usage package
  // deliberately ships no WorkBuddy querier, because only this package knows
  // how to reach that app's billing endpoint. Absent provider-usage (the user
  // removed it), the registration never happens and the model channel is
  // unaffected.
  //
  // The service is read structurally through `ctx.get` rather than by
  // declaring `providerUsage` on Context: two packages declaring the same
  // member is a TypeScript error, and this package must not import the other's
  // types just to reach an optional neighbour (they install independently).
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
          return {
            provider: runtime.variant.id,
            displayName: runtime.variant.displayName,
            // One window per *live* billing package: these are monthly
            // (occasionally half-yearly) cycles, and only the per-package rows
            // say which one is about to run dry. Zero-remain packages are
            // dropped for the same reason the card drops them — a real account
            // accumulates dozens of drained and expired grants, and listing
            // them would bury the two that still have credit.
            windows: credits.accounts
              .filter(account => account.remain > 0)
              .map((account, index) => ({
                id: `package-${String(index)}`,
                label: account.packageName,
                remain: account.remain,
                unit: 'credits',
                ...account.size > 0 ? { limit: account.size } : {},
              })),
            fetchedAt: Date.now(),
          }
        },
        runtime.variant.displayName,
      ), 'dsh-any-connect: usage querier')
    }
  })

  // This plugin ships its own configuration cards: opt out of the host's
  // auto-generated settings page (mirroring upstream `dsh-llm-pi-ai`). The
  // inject waits for a settings service to exist — without one the plugin
  // still serves its models, as before.
  ctx.inject(['settings'], (child: Context) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // DSH 0.1.7 commits profile edits into the volatile references without a
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
      refreshCatalog(runtime, 'authFile changed')
    }
  })

  /** 从上游拉一次模型目录并写入 catalog；启动、配置变更、身份核对共用。
   * 函数声明（而非 const 箭头）：`loader/volatile-update` 处理器引用它，
   *
   * 身份语义（与上游 dsh-workbuddy-connect 的 adoptIdentity 同构）：
   * - 未登录 → 隐藏分组（adoptSignedOut），不展示兜底名单；
   * - 区域错配 → 同样隐藏分组，但不重试（重试修不好配错的文件），原因
   *   由 status 的 reason 字段报给卡片；
   * - 账号切换 → 先上该账号最好的已知目录（saved 优先于 fallback）并立即可见，
   *   再拉取 live；拉取中的旧身份迟到响应由 lastIdentity 挡掉，不覆盖新身份；
   * - 拉取失败 → 保留已发布的内容（saved/fallback），只记录 error 并按既有
   *   策略重试，重试耗尽即停。 */
  function refreshCatalog(runtime: VariantRuntime, reason: string, retriesLeft = CATALOG_REFRESH_RETRIES): void {
    const { store, catalog, catalogStore, variant } = runtime
    const retry = (left: number): void => {
      if (left > 0 && !stopped) {
        setTimeout(() => { if (!stopped) refreshCatalog(runtime, `${reason}; retry`, left - 1) }, CATALOG_REFRESH_RETRY_MS).unref()
      }
    }
    void (async () => {
      try {
        // current() 只探是否已登录（未登录静默隐藏分组，不告警不重试）；
        // 真正取凭据用 resolve()：桌面文件里的 access token 过期是常态
        // （离屏很久后启动），current() 的旧 token 会让 fetchModels 必 401、
        // 目录永远停在旧快照——resolve() 会按需刷新并落盘。
        const signedIn = await store.current()
        if (signedIn === undefined || stopped) {
          if (signedIn === undefined && !stopped) adoptSignedOut(runtime)
          return
        }
        const credential = await store.resolve()
        if (stopped) return
        // WorkBuddy 凭据带 uid/enterpriseId；RuntimeStore 的结构最小化类型
        // 只承诺 accessToken，这里按 kind 已分流的前提下还原完整形状。
        const identity = credentialIdentity(credential as unknown as Parameters<typeof credentialIdentity>[0])
        if (identity !== runtime.lastIdentity) {
          // 账号真的换了（不是首次采用）：旧账号的探针记录不能留给新账号。
          // 首次登录不清除——那会删掉该账号自己在重启前写入的记录。
          if (runtime.lastIdentity !== undefined) runtime.probeStore!.clear()
          runtime.lastIdentity = identity
          // 该账号最好的已知目录：上次成功拉取的 saved 优先于编译期 fallback。
          // saved 是"这个账号实际被服务过"的名单，比一次性快照更可信；这同时
          // 覆盖重启场景——重启后 saved 正是阻止分组落回内置名单的东西。
          const saved = catalogStore!.saved(identity)
          if (saved !== undefined) {
            catalog.set([...saved.models])
            runtime.catalogSource = 'saved'
            runtime.catalogFetchedAtMs = saved.fetchedAtMs
          } else {
            catalog.set(fallbackFor(variant))
            runtime.catalogSource = 'fallback'
            runtime.catalogFetchedAtMs = undefined
          }
          runtime.catalogError = undefined
          catalog.setVisible(true)
          // saved/fallback 目录先行发布时同样补齐缺失检测：行与旧目录不同
          // 的候选（fingerprint 失效）在这里入队；随后 live 拉取成功会再触
          // 发一次，pending 去重保证同一模型不重复跑。
          runtime.probeService?.probeMissingCandidates()
        }
        const generation = runtime.lastIdentity
        const models = await (runtime.client ?? client).fetchModels(credential as Parameters<WorkBuddyUpstreamClient['fetchModels']>[0])
        if (stopped) return
        // 拉取中账号又变了（切换/登出）：迟到响应直接丢弃，不覆盖新身份。
        if (generation !== runtime.lastIdentity) return
        catalog.set([...models])
        catalog.setVisible(true)
        runtime.catalogSource = 'live'
        runtime.catalogFetchedAtMs = Date.now()
        runtime.catalogError = undefined
        await catalogStore!.save({
          account: identity,
          source: variant.kind === 'zcode' ? 'https://open.bigmodel.cn' : chatBase(credential as unknown as Parameters<typeof chatBase>[0]),
          fetchedAtMs: runtime.catalogFetchedAtMs,
          models: [...models],
        })
        // 目录落地即补齐缺失的档位检测（仅当用户开启过自动检测）：新模型、
        // 行变化导致旧记录失效的模型，都在这里自动入队。
        runtime.probeService?.probeMissingCandidates()
      } catch (error: unknown) {
        if (error instanceof RegionMismatchError) {
          // 配错了文件：隐藏分组并把原因留给卡片，不重试。
          if (!stopped) {
            adoptSignedOut(runtime)
            runtime.catalogError = undefined
            ctx.logger?.warn?.(`dsh-any-connect: ${variant.displayName} ${error.message}`)
          }
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        runtime.catalogError = message.slice(0, 300)
        ctx.logger?.warn?.(
          `dsh-any-connect: dynamic model catalog unavailable (${variant.id}; ${reason}); serving the last-known list`,
          error,
        )
        // 有限次延迟重试：刚启动时上游/网络暂不可达是暂态，自动恢复实时
        // 目录；重试耗尽则停在已发布的内容（saved/fallback），不再打扰。
        // 重试全程 stopped 已挡，插件卸载后的残留定时器最多空转一次。
        retry(retriesLeft)
      }
    })()
  }
  ctx.effect(() => () => {
    stopped = true
    clearInterval(sweep)
    clearInterval(catalogTimer)
    // close 期间 server 的 error 事件会 reject 该 promise,不捕获就是
    // unhandled rejection——Node 默认策略下会终止宿主进程,且恰发生在
    // dispose 路径。降级为告警日志。
    for (const runtime of runtimes) {
      runtime.shim.close().catch(error => ctx.logger?.warn?.(`dsh-any-connect: shim close failed: ${error}`))
    }
    void clearHostHeartbeat()
  })

  // 身份核对：只读 current()，身份没变就什么都不做（零上游请求）。
  // 用 unref 的 interval，vitest 假时钟下 advanceTimers 会触发它——回调内
  // 无身份变化时不触网，现有重试计数测试不受影响。区域错配在这里静默隐藏
  // （原因已由 status 报给卡片），不每 60s 打一条告警。
  const sweep = setInterval(() => {
    if (stopped) return
    for (const runtime of runtimes) {
      void (async () => {
        try {
          const signedIn = await runtime.store.current()
          const identity = signedIn === undefined
            ? undefined
            : credentialIdentity(signedIn as unknown as Parameters<typeof credentialIdentity>[0])
          if (identity !== runtime.lastIdentity && !stopped) refreshCatalog(runtime, 'identity sweep')
        } catch (error: unknown) {
          if (error instanceof RegionMismatchError) {
            if (!stopped) adoptSignedOut(runtime)
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
  const catalogTimer = setInterval(() => {
    if (stopped) return
    for (const runtime of runtimes) {
      if (runtime.variant.kind === 'workbuddy') refreshCatalog(runtime, 'scheduled refresh')
    }
  }, CATALOG_REFRESH_INTERVAL_MS)
  catalogTimer.unref()

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
            store: runtime.credentialStore!,
            recordFor: modelId => runtime.probeService?.recordFor(modelId),
            resolveAttachments: () => ctx.get('attachments'),
          })

          let releaseAdapter: (() => void) | undefined
          let releaseDirectory: (() => void) | undefined
          try {
            releaseAdapter = ctx.llm.registerAdapter([variant.id], adapter.adapter)
            releaseDirectory = ctx.llm.registerConfigurableProviders([{
              provider: variant.id,
              displayName: variant.displayName,
              // DSH 0.1.7: directory entries point at the Loader profile entry
              // id; without a Loader fall back to the legacy namespace so
              // bare-Context installs keep a stable, testable identity.
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
          try {
            ctx.effect(() => () => {
              releaseAdapter?.()
              releaseDirectory?.()
            })
          } catch {
            // The plugin was disposed during registration; release immediately —
            // the plugin-level disposer already closed the shim.
            releaseAdapter?.()
            releaseDirectory?.()
          }

          // The host bundle is live: write a heartbeat so the status CLI can
          // report host health without a browser. Cleared on disposal; a stale
          // heartbeat after a crash is detected by PID in the reader.
          void writeHostHeartbeat()
        } catch (error: unknown) {
          ctx.logger.error('dsh-any-connect: provider registration failed', error)
          return
        }

        refreshCatalog(runtime, 'startup')
      })
      .catch((error: unknown) => {
        ctx.logger.error('dsh-any-connect: loopback endpoint failed to start; provider not registered', error)
      })
  }
}
