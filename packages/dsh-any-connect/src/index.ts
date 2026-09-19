/**
 * WorkBuddy and GLM Coding Plan (zcode) models for DeepSeek Harness. The
 * WorkBuddy providers reuse the desktop apps' sign-in; the zcode provider
 * serves a GLM Coding Plan API key. Streaming, tool calls, compaction, and
 * permissions stay Harness-owned.
 * @module dsh-any-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { RegionMismatchError, WorkBuddyCredentialStore } from './auth.js'
import { FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, FALLBACK_ZCODE_MODELS, FALLBACK_ZCODE_OFFPEAK_MODELS, WorkBuddyCatalog } from './catalog.js'
import type { WorkBuddyModelInfo } from './catalog.js'
import { WorkBuddyCatalogStore, credentialIdentity, workbuddyCatalogPath } from './catalog-store.js'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.js'
import { createWorkBuddyShim } from './shim.js'
import type { WorkBuddyShim } from './shim.js'
import { WorkBuddyUpstreamClient, chatBase } from './upstream.js'
import { ZcodeCredentialStore } from './zcode-auth.js'
import { ZcodeClientSigning } from './zcode-signing.js'
import { zcodeIdentity, ZcodeUpstreamClient } from './zcode-upstream.js'
import { ZcodeOffpeakCredentialStore, ZcodeOffpeakUpstreamClient } from './zcode-offpeak.js'
import type { ZcodeCredential } from './zcode-auth.js'
import type { ZcodeOffpeakCredential } from './zcode-offpeak.js'
import type { WorkBuddyCredential } from './auth.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.js'
import { WorkBuddyProbeService } from './probe-service.js'
import { newestFirst, workbuddyProbePath, WorkBuddyProbeStore } from './probe-store.js'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.js'
import { ANYCONNECT_VERSION } from './version.js'
import { AI_VARIANT, CN_VARIANT, PROVIDER_VARIANTS, WORKBUDDY_VARIANTS, ZCODE_OFFPEAK_VARIANT, ZCODE_VARIANT } from './variants.js'
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
  ZCODE_API_KEY_ENV,
  ZCODE_AUTH_FILENAME,
  ZcodeCredentialStore,
  maskApiKey,
  zcodeOwnAuthPath,
  type ZcodeCredential,
} from './zcode-auth.js'
export { ZCODE_ANTHROPIC_BASE, ZcodeUpstreamClient, resolveZcodeAppVersion, zcodeIdentityHeaders, type ZcodeChatResult } from './zcode-upstream.js'
export { ZcodeClientSigning, parseClientSigningCredential, isSignatureRejection, ZcodeHandshakeError } from './zcode-signing.js'
export {
  ZCODE_OFFPEAK_BASE,
  ZcodeOffpeakCredentialStore,
  ZcodeOffpeakTickets,
  ZcodeOffpeakUpstreamClient,
  ZcodeOffpeakUnavailableError,
  type ZcodeOffpeakCredential,
  type ZcodeOffpeakTicketState,
} from './zcode-offpeak.js'
export {
  WorkBuddyCatalogStore,
  WORKBUDDY_CATALOG_FILENAME,
  credentialIdentity,
  workbuddyCatalogPath,
  type SavedWorkBuddyCatalog,
} from './catalog-store.js'
export {
  defaultDesktopAuthCandidates,
  desktopAuthCandidatesFor,
  defaultDesktopAuthPath,
  parseWorkBuddyAuth,
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
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyPromotion,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.js'
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
 * Settings namespace owning the configuration card.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'anyconnect'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
export const WORKBUDDY_SETTINGS_NS = 'anyconnect' as SettingsNamespace

/** Settings namespace owning the international variant's card. */
export const WORKBUDDY_AI_SETTINGS_NS = 'anyconnect-ai' as SettingsNamespace

/** Settings namespace owning the zcode variant's card. */
export const WORKBUDDY_ZCODE_SETTINGS_NS = 'anyconnect-zcode' as SettingsNamespace

/** Settings namespace owning the zcode off-peak variant's card. */
export const WORKBUDDY_ZCODE_OFFPEAK_SETTINGS_NS = 'anyconnect-zcode-offpeak' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /** Explicit WorkBuddy AI desktop auth-file path, overriding env and platform defaults. */
  authFileAI?: string
  /**
   * GLM Coding Plan API key for the zcode provider (from the bigmodel
   * console, same account as the coding plan). Blank falls through to
   * `ZCODE_API_KEY` and then the plugin-owned key file.
   */
  apiKeyZcode?: string
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent
   * until the user explicitly agrees. (Only manual, per-click-confirmed
   * probes run; this gates any future automatic trigger.)
   */
  probeConsent?: boolean
}

const PROBE_CONSENT_FIELD = z.boolean().default(false)
  .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)')

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  authFileAI: z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)'),
  apiKeyZcode: z.string().description('GLM Coding Plan API key (bigmodel console; blank = ZCODE_API_KEY env or ~/.dsh/.zcode-auth.json)'),
  probeConsent: PROBE_CONSENT_FIELD,
})

/** One variant's settings section: only the fields that card edits. */
const CN_SECTION: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
  probeConsent: PROBE_CONSENT_FIELD,
})

/** The international card's settings section: only its own auth-file path. */
const AI_SECTION: z<Config> = z.object({
  authFileAI: z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)'),
})

/** The zcode card's settings section: only its API key. */
const ZCODE_SECTION: z<Config> = z.object({
  apiKeyZcode: z.string().description('GLM Coding Plan API key (bigmodel console; blank = ZCODE_API_KEY env or ~/.dsh/.zcode-auth.json)'),
})

/** off-peak 卡无用户可编辑字段（凭据完全跟随 zcode 登录态），装一个空 section
 * 让 provider 目录能挂上命名空间。 */
const ZCODE_OFFPEAK_SECTION = z.object({}) as unknown as z<Config>

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
 * Structural minimum every variant's credential store satisfies. Credentials
 * travel opaquely: WorkBuddy carries OAuth fields, zcode an API key, off-peak
 * a JWT+key pair — only the WorkBuddy paths ever look inside.
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
  /** 上次发布过目录的账号（WorkBuddy 为 `uid:enterpriseId`，zcode 为常量），或 undefined。 */
  lastIdentity: string | undefined
  /** WorkBuddy-only parts: live catalog lifecycle, refresh, probe. */
  client?: WorkBuddyUpstreamClient
  credentialStore?: WorkBuddyCredentialStore
  catalogStore?: WorkBuddyCatalogStore
  probeStore?: WorkBuddyProbeStore
  probeService?: WorkBuddyProbeService
  /** zcode-only parts: static catalog, API-key credential store. */
  zcodeStore?: ZcodeCredentialStore
  /** off-peak-only parts: JWT+plan-key credential store and the relay client. */
  offpeak?: {
    store: ZcodeOffpeakCredentialStore
    client: ZcodeOffpeakUpstreamClient
  }
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

/** 常量账号身份（zcode 家族）：key 可随时更换且无账号概念，目录又是静态的，
 * 无需按账号隔离任何状态——直接用 provider id。 */
function zcodeFamilyIdentity(variant: WorkBuddyVariant): string {
  return variant.id
}

/** The static catalog a variant serves before its first successful fetch. */
const FALLBACK_BY_ID = new Map<string, readonly WorkBuddyModelInfo[]>([
  [CN_VARIANT.id, FALLBACK_WORKBUDDY_MODELS],
  [AI_VARIANT.id, FALLBACK_WORKBUDDY_AI_MODELS],
  [ZCODE_VARIANT.id, FALLBACK_ZCODE_MODELS],
  [ZCODE_OFFPEAK_VARIANT.id, FALLBACK_ZCODE_OFFPEAK_MODELS],
])

function fallbackFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  return FALLBACK_BY_ID.get(variant.id) ?? FALLBACK_WORKBUDDY_MODELS
}

/** The auth-file config field a WorkBuddy variant edits, if it has one. */
const AUTH_FILE_FIELD_BY_ID = new Map<string, 'authFile' | 'authFileAI'>([
  [CN_VARIANT.id, 'authFile'],
  [AI_VARIANT.id, 'authFileAI'],
])

function configuredAuthFile(config: Config, variant: WorkBuddyVariant): string | undefined {
  const field = AUTH_FILE_FIELD_BY_ID.get(variant.id)
  return field === undefined ? undefined : config[field]
}

/**
 * Start all providers: their loopback endpoints, the `workbuddy`,
 * `workbuddy-ai`, and `zcode` providers, their configuration cards, and
 * their credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  let stopped = false
  let current = () => config

  /** Build one variant's stores and catalog; the shim starts below. */
  function createRuntime(variant: WorkBuddyVariant): VariantRuntime {
    const catalog = new WorkBuddyCatalog(fallbackFor(variant))
    // Start hidden: a variant must serve no models until an account has actually
    // been adopted, so a signed-out variant is empty rather than showing a roster
    // whose models could only fail.
    catalog.setVisible(false)
    if (variant.kind === 'zcode') {
      const zcodeStore = new ZcodeCredentialStore({
        configuredKey: current().apiKeyZcode,
      })
      const signing = new ZcodeClientSigning({ clientVersion: () => zcodeIdentity()['x-zcode-app-version'] ?? '3.12.3' })
      const zcodeClient = new ZcodeUpstreamClient({ signing, logger: ctx.logger })
      const shim = createWorkBuddyShim({
        kind: 'zcode',
        resolveCredential: () => zcodeStore.resolve(),
        forwardMessages: (credential, rawBody, signal) =>
          zcodeClient.forwardMessages(credential as ZcodeCredential, rawBody, signal),
        catalog,
        logger: ctx.logger,
      })
      return {
        variant, store: zcodeStore, catalog, shim, zcodeStore,
        catalogSource: 'fallback',
        catalogFetchedAtMs: undefined,
        catalogError: undefined,
        lastIdentity: undefined,
      }
    }
    if (variant.kind === 'zcode-offpeak') {
      const offpeakStore = new ZcodeOffpeakCredentialStore()
      const offpeakClient = new ZcodeOffpeakUpstreamClient({ identityHeaders: zcodeIdentity, logger: ctx.logger })
      const shim = createWorkBuddyShim({
        kind: 'zcode-offpeak',
        resolveCredential: () => offpeakStore.resolve(),
        forwardMessages: (credential, rawBody, signal) =>
          offpeakClient.forwardMessages(credential as ZcodeOffpeakCredential, rawBody, signal),
        catalog,
        logger: ctx.logger,
      })
      return {
        variant, store: offpeakStore, catalog, shim, offpeak: { store: offpeakStore, client: offpeakClient },
        catalogSource: 'fallback',
        catalogFetchedAtMs: undefined,
        catalogError: undefined,
        lastIdentity: undefined,
      }
    }
    const configured = configuredAuthFile(config, variant)
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
      consent: () => current().probeConsent === true,
      // Observations are per account: the service reads and writes its records
      // against this identity, so one account's detected levels never answer
      // for another's.
      account: () => runtime.lastIdentity,
    })
    return runtime
  }

  const runtimes = WORKBUDDY_VARIANTS.map(createRuntime)

  /** Per-process key authorizing probe control writes; handed to the cards. */
  const probeKey = createProbeKey()

  /**
   * Compact probe state for one card: consent, candidates, observations.
   *
   * Results read through the *same* judgement the adapter uses, rather than
   * straight from the store: a raw record can be stale in ways the adapter
   * already discounts (row changed, TTL passed, upstream since declared a set
   * that always wins) — showing one would have the card promise levels the
   * model picker does not offer.
   */
  function probeSection(runtime: VariantRuntime, consent: boolean): WorkBuddyWebProbeSection {
    // 仅 WorkBuddy 变体携带探针服务；status 路由也只对它们启用 probe 字段。
    if (runtime.probeService === undefined) {
      return { consent, running: false, candidates: [], results: [] }
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
      consent,
      running: runtime.probeService.isRunning(),
      candidates: runtime.catalog.current()
        .filter(info => info.reasoning?.supports === true && (info.reasoning.supportedEfforts?.length ?? 0) === 0)
        .map(info => info.id),
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
        // zcode has no credit ledger (the plan quota lives behind a signed
        // management API), so its card omits the billing section entirely.
        ...runtime.client === undefined ? {} : {
          fetchCredits: credential => runtime.client!.fetchCredits(credential as Parameters<WorkBuddyUpstreamClient['fetchCredits']>[0]),
        },
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        // 探针区只属于 WorkBuddy 变体；zcode 的 status 文档省略 probe 字段，
        // 卡片随即隐藏检测 UI（.refreshModels 的目录刷新走下方 probe 路由）。
        ...runtime.variant.kind === 'workbuddy'
          ? { probe: () => probeSection(runtime, current().probeConsent === true) }
          : {},
        probeKey,
      })
      registerWorkBuddyProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        probe: runtime.variant.kind !== 'workbuddy'
          ? async () => ({ state: 'unavailable' as const, reason: 'this provider does not support effort detection' })
          : async modelId => {
            const result = await runtime.probeService!.probe(modelId, true)
            return result.state === 'ok'
              ? { state: 'ok' as const }
              : { state: 'unavailable' as const, reason: result.reason }
          },
        clear: () => { runtime.probeStore?.clear() },
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
      // 额度查询是 WorkBuddy 专属（credits 账本）；zcode 系凭据打这个端点
      // 必然失败（zcode 套餐余量在有签名的管理面之后，不可查），不注册。
      if (runtime.variant.kind !== 'workbuddy') continue
      usageCtx.effect(() => usage.register(
        runtime.variant.id,
        async context => {
          const credential = await runtime.store.resolve() as WorkBuddyCredential
          if (context.signal?.aborted === true) throw context.signal.reason ?? new Error('aborted')
          const credits = await client.fetchCredits(credential)
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

  // The settings sections are what make the providers visible on the Models
  // settings page (settings.describe joins the provider directory), and they
  // keep the configured auth-file paths and API keys live across edits.
  //
  // DSH 0.1.2 moved the helper from a free function (`installSettingsSection`)
  // onto the provider service (`settings.installSection`), so the wiring now
  // has to wait for a settings service to exist — exactly what the inject
  // below does. Without one the plugin still serves its models; it simply has
  // no user-editable sections, as before.
  ctx.inject(['settings'], (settingsCtx: Context) => {
    const sections = [
      { ns: WORKBUDDY_SETTINGS_NS, schema: CN_SECTION, field: 'authFile' },
      { ns: WORKBUDDY_AI_SETTINGS_NS, schema: AI_SECTION, field: 'authFileAI' },
      { ns: WORKBUDDY_ZCODE_SETTINGS_NS, schema: ZCODE_SECTION, field: 'apiKeyZcode' },
      // off-peak 卡无编辑字段，只为 provider 目录挂命名空间。
      { ns: WORKBUDDY_ZCODE_OFFPEAK_SETTINGS_NS, schema: ZCODE_OFFPEAK_SECTION, field: undefined },
    ] as const
    // installSection 的 setSource 每次都会覆盖同一个引用：若所有 section 共享
    // 一个 `current`，只有最后安装的 section 的 scope 是新鲜的，其余 section
    // 的 onChange 会读到 base 旧值（authFile / probeConsent 的「改后即时生效」
    // 因此一直是坏的）。改为按 ns 自存 scope，`current` 合成各 ns 自有字段
    // 的最新视图。
    const scopeByNs = new Map<SettingsNamespace, () => Config>()
    /** 每个 section 拥有的 Config 字段（onChange 与合并视图都以它为准）。 */
    const fieldsByNs = new Map<SettingsNamespace, ReadonlyArray<keyof Config>>([
      [WORKBUDDY_SETTINGS_NS, ['authFile', 'probeConsent']],
      [WORKBUDDY_AI_SETTINGS_NS, ['authFileAI']],
      [WORKBUDDY_ZCODE_SETTINGS_NS, ['apiKeyZcode']],
      [WORKBUDDY_ZCODE_OFFPEAK_SETTINGS_NS, []],
    ])
    const mergedCurrent = (): Config => {
      const merged: Config = { ...config }
      const writable = merged as Record<string, unknown>
      for (const [ns, fields] of fieldsByNs) {
        const get = scopeByNs.get(ns)
        if (get === undefined) continue
        const resolved = get() as Partial<Config>
        for (const field of fields) writable[field] = resolved[field]
      }
      return merged
    }
    for (const [index, section] of sections.entries()) {
      const runtime = runtimes[index]!
      settingsCtx.settings.installSection(ctx, section.ns, section.schema, config, {
        setSource(source: () => Config) {
          scopeByNs.set(section.ns, source)
          current = mergedCurrent
        },
        onChange() {
          if (section.field === undefined) return
          const own = scopeByNs.get(section.ns)
          const next = (own === undefined ? current() : own())[section.field] as string | undefined
          // WorkBuddy 卡改的是凭据文件路径；zcode 卡改的是 key 本身。
          if (section.field === 'apiKeyZcode') {
            runtime.zcodeStore?.setConfiguredKey(next)
          } else {
            runtime.credentialStore?.setDesktopPath(next)
          }
          // 凭据变化后重拉模型目录：目录只在启动时拉一次的话，晚登录/换
          // 账号的用户会一直停在旧名单，直到插件重载。拉取失败仅告警，
          // last-known 目录照常服务。
          refreshCatalog(runtime, section.field === 'apiKeyZcode' ? 'apiKey changed' : 'authFile changed')
        },
      })
    }
  })

  /** 从上游拉一次模型目录并写入 catalog；启动、authFile 变更、身份核对共用。
   * 函数声明（而非 const 箭头）：settings 服务已在场时 inject 回调同步
   * 执行，onChange 必须引用得到提升后的绑定。
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
    // zcode 家族的目录是编译期静态名单：没有 live/saved 两层，唯一的生命周期
    // 事件是「凭据从无到有 / 从有到无」——出现即发布并可见，消失即隐藏。
    if (variant.kind !== 'workbuddy') {
      void (async () => {
        try {
          const credential = await store.current()
          if (credential === undefined || stopped) {
            if (credential === undefined && !stopped) adoptSignedOut(runtime)
            return
          }
          const identity = zcodeFamilyIdentity(variant)
          if (runtime.lastIdentity !== identity) {
            runtime.lastIdentity = identity
            catalog.set(fallbackFor(variant))
            catalog.setVisible(true)
            runtime.catalogSource = 'fallback'
            runtime.catalogFetchedAtMs = undefined
            runtime.catalogError = undefined
          }
        } catch (error: unknown) {
          if (!stopped) {
            runtime.catalogError = (error instanceof Error ? error.message : String(error)).slice(0, 300)
            ctx.logger?.warn?.(`dsh-any-connect: ${variant.id} credential unavailable (${reason})`, error)
          }
        }
      })()
      return
    }
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
        }
        const generation = runtime.lastIdentity
        const models = await client.fetchModels(credential as Parameters<WorkBuddyUpstreamClient['fetchModels']>[0])
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
          source: chatBase(credential as unknown as Parameters<typeof chatBase>[0]),
          fetchedAtMs: runtime.catalogFetchedAtMs,
          models: [...models],
        })
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
          // zcode 家族无账号概念：凭据在即恒定身份；WorkBuddy 按 uid 判定。
          const identity = signedIn === undefined
            ? undefined
            : runtime.variant.kind === 'workbuddy' ? credentialIdentity(signedIn as unknown as Parameters<typeof credentialIdentity>[0]) : zcodeFamilyIdentity(runtime.variant)
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

  for (const runtime of runtimes) {
    const { catalog, shim, variant } = runtime
    void shim.ready
      .then(() => {
        if (stopped) return

        try {
          // Constructed only once the listener holds a port: the provider's
          // models read the shim origin at construction time. WorkBuddy
          // speaks OpenAI completions through the shim; zcode speaks
          // Anthropic Messages passthrough.
          const adapter = createWorkBuddyAdapter({
            shim,
            catalog,
            providerId: variant.id,
            displayName: variant.displayName,
            ...variant.kind !== 'workbuddy'
              ? { api: 'anthropic-messages' as const }
              : {
                  store: runtime.credentialStore!,
                  recordFor: modelId => runtime.probeService!.recordFor(modelId),
                },
            resolveAttachments: () => ctx.get('attachments'),
          })

          let releaseAdapter: (() => void) | undefined
          let releaseDirectory: (() => void) | undefined
          try {
            releaseAdapter = ctx.llm.registerAdapter([variant.id], adapter.adapter)
            releaseDirectory = ctx.llm.registerConfigurableProviders([{
              provider: variant.id,
              displayName: variant.displayName,
              settingsNs: variant.settingsNs,
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
