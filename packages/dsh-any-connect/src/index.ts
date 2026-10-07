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
import { WorkBuddyUpstreamClient, ZCodeUpstreamClient, chatBase, isZCodeOffpeak } from './upstream.js'
import type { WorkBuddyCredential, ZCodePlanKind } from './auth.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.js'
import { applyZCodePlanOverride, isNightFreeEligiblePlan } from './zcode-plan-store.js'
import { WorkBuddyProbeService } from './probe-service.js'
import { newestFirst, workbuddyProbePath, WorkBuddyProbeStore } from './probe-store.js'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.js'
import { ANYCONNECT_VERSION } from './version.js'
import { AI_VARIANT, CN_VARIANT, PROVIDER_VARIANTS, WORKBUDDY_VARIANTS, ZCODE_START_PLAN_VARIANT, ZCODE_VARIANT } from './variants.js'
import type { WorkBuddyVariant } from './variants.js'
import { registerWorkBuddyStatusRoute } from './web-status.js'
import { filterByCodingPlanWhitelist } from './zcode-builtin-catalog.js'
import type { StartPlanPreviewResult } from './zcode-plan-claim.js'
import { fallbackFor, variantIsStartPlan } from './variant-runtime.js'
import type { VariantRuntime } from './variant-runtime.js'
import { registerUsageQueriers } from './usage.js'
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

/** 目录行里"会被渲染出来"的字段，按固定顺序取——顺序固定才谈得上稳定指纹。 */
const CATALOG_FINGERPRINT_BILLING_KEYS = ['credits', 'badges', 'free', 'rateUnknown'] as const

/** 一行目录参与指纹的展示字段（顺序即拼接顺序）。 */
function catalogFingerprintRow(model: WorkBuddyModelInfo): string {
  return [
    model.id,
    model.name,
    String(model.contextWindow),
    String(model.maxTokens),
    model.supportsImages === true ? '1' : '0',
    JSON.stringify(model.reasoning ?? null),
    JSON.stringify(CATALOG_FINGERPRINT_BILLING_KEYS.map(key => model.billing?.[key] ?? null)),
  ].join('\u0001')
}

/**
 * 一份**已发布目录**的内容指纹：可见性 + 每行的展示字段。
 *
 * 用于判断"这次刷新到底改没改用户看得见的东西"。取内容而非对象引用，因为
 * 每次刷新都会重建整份数组——引用比较会让每一轮定时刷新都被判成变化。
 *
 * 覆盖三件用户可见的事：某行被增删/改名/换窗口与输出上限/换图片能力/换档位
 * 集合（选择器的档位子菜单）、billing 徽标与费率（名称后缀），以及**整组是否
 * 可见**（未登录时空目录；Start Plan 今日未领取 → 空名单 → DSH 隐藏该分组）。
 * 后两者正是"名单看起来不对"最常见的两种形态，都必须通知出去。
 *
 * 刻意**不**放 `maxInputTokens` / `supportedContextWindows` / `promotions`：
 * 它们不在模型的展示名里，纳进来只会让无谓的广播变多，而"只在变化时通知"
 * 正是这条线的硬要求。
 *
 * @param models - 目录里即将发布的内容（{@link WorkBuddyCatalog.current} 的返回）。
 * @param visible - 该分组对用户是否可见。
 * @returns 稳定可比较的字符串指纹。
 */
export function catalogFingerprint(
  models: readonly WorkBuddyModelInfo[],
  visible = true,
): string {
  if (!visible) return 'hidden'
  return models.map(catalogFingerprintRow).join('\u0002')
}

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
 * status 读路径上探测"今日待领取"的超时：卡片每 60s 轮询一次，探测只是一条
 * 提示性信息，绝不能让它拖住整份文档。3s 足够一次正常的上游往返（其余 JSON
 * 端点用的是 30s，那是**调用方等待**的场景，这里不是）。
 */
const START_PLAN_CLAIM_PROBE_TIMEOUT_MS = 3_000

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

  /**
   * Start Plan 的「上拍还可领、这拍已领走」标记（每变体一份）。
   *
   * 只用于**跳变判定**，不作为任何展示判断——false 既可能是「已领取」也可能是
   * 「没探到」（探测失败不写它）。
   */
  const claimWasAvailable = new Map<string, boolean>()

  /**
   * 空名单自愈阈值：Start Plan 目录为空且领取探测无翻转时，距上次拉取超过
   * 该时长就在 sweep 里再拉一拍。上游偶发地答一个空活动清单(间歇抖动)时,
   * 小时刷新要等一整小时,5 分钟自愈把分组消失的时间压到分钟级;拉取本身
   * 无论结果都会前移 fetchedAtMs,不会形成每拍重拉的循环。
   */
  const EMPTY_ROSTER_SELF_HEAL_MS = 5 * 60_000

  /**
   * Start Plan 的廉价状态翻转快通道：目录为空时探一次「今天还能不能领」
   * （{@link claimPreviewFor}，纯 HTTP、无 captcha、3s 超时），返回「是否刚刚
   * 从可领翻到不可领」——那正是**用户刚领完**的唯一信号。
   *
   * 为什么需要它：用户领取既不改变凭据身份、也不落在夜免边界上，身份 sweep 的
   * shouldRefresh 恒为假；而 Start Plan 专属通道的模型名单就是「今天领到了什么」
   * （见 zcode-plan-models），没领时上游返回空。于是「今日未领取 → 用户在客户端
   * 领取」这段时间里分组会一直空着，直到下一次小时刷新——用户以为要等一小时。
   * 这条快通道把恢复压到一拍（≤60s）。
   *
   * **稳态零额外请求**：目录非空就完全不探测。目录非空 = 今天已经领到了，
   * 常规的小时刷新足够覆盖上游漂移，不需要在这里再问一次。
   *
   * 探测失败（含超时/无凭据/上游报错）一律当作**没探到**：既不触发刷新，也不
   * 改动标记——避免一次网络抖动既打无谓的上游请求、又把下一拍的判断搅乱。
   * 异常绝不冒泡：sweep 里其它变体与身份核对照常进行。
   */
  async function claimFlipChanged(runtime: VariantRuntime): Promise<boolean> {
    const { variant } = runtime
    if (!variantIsStartPlan(variant)) return false
    // 有模型 = 今天已经领到，快通道无事可做（也就零额外请求）。
    if (runtime.catalog.current().length > 0) {
      claimWasAvailable.delete(variant.id)
      return false
    }
    let preview: StartPlanPreviewResult
    try {
      const signedIn = await runtime.store.current()
      if (signedIn === undefined) return false
      const credential = await runtime.store.resolve() as WorkBuddyCredential
      preview = await claimPreviewFor(runtime)(credential)
    } catch {
      // 凭据读不到 / 探测抛错 / 超时：一律「没探到」，不刷新也不改标记。
      return false
    }
    if (preview.status !== 'ok') return false
    const available = preview.plans.length > 0
    const previous = claimWasAvailable.get(variant.id)
    claimWasAvailable.set(variant.id, available)
    // 上一拍还能领、这一拍不能领了 = 用户刚完成领取。
    return previous === true && !available
  }

  /**
   * Start Plan 变体的领取提示探测器。
   *
   * **必须短超时**：它挂在卡片每 60s 轮询的 status 读路径上，一个挂死的上游
   * 不能让整份文档等着。所以这里先包一层 `AbortSignal.timeout`——探不到就是
   * `unknown`（web-status 收敛），而不是把 status 拖成 500。
   *
   * 每次探测都**重新读凭据**：用户刚在客户端登录/换号后，卡片最多一拍即能
   * 看到新的可领状态，不需要重载插件。
   */
  function claimPreviewFor(runtime: VariantRuntime): (credential: WorkBuddyCredential) => Promise<StartPlanPreviewResult> {
    const zcodeClient = runtime.client as ZCodeUpstreamClient
    return credential => zcodeClient.fetchStartPlanClaimPreview(credential, {
      signal: AbortSignal.timeout(START_PLAN_CLAIM_PROBE_TIMEOUT_MS),
    })
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
    // 未登录不是「上游说没有模型」：那张卡片该说的是「去登录」，不是空名单说明。
    runtime.catalogEmpty = false
    publishCatalog(runtime)
  }

  /**
   * 目录内容变化 → 通知宿主"适配器拓扑变了"，正在开着的聊天页当场重拉模型
   * 选择框的名单。这是"模型列表实时更新"的全部接线，见 {@link notifyCatalogChanged}。
   *
   * **只在内容真的变了时通知**：宿主每小时都会重拉一次目录
   * （{@link CATALOG_REFRESH_INTERVAL_MS}），多数时候名单一模一样；无条件通知会让
   * 每个打开的客户端每小时白重拉一次目录、白重渲染一次选择框。指纹取内容
   * （{@link catalogFingerprint}），不能用数组引用——每次刷新都会重建整份数组。
   *
   * 快照取 `current()`：可见 → 与适配器此刻服务给宿主的行完全一致；不可见 → 空，
   * 与宿主看到的空分组一致（这正是"Start Plan 今日未领取就该隐藏分组"那次变化）。
   * 必须在本次发布**之后**调用，否则会把刚写进去的内容判成"没变"而漏掉通知。
   */
  function publishCatalog(runtime: VariantRuntime): void {
    const visible = runtime.catalog.isVisible()
    const fingerprint = catalogFingerprint(visible ? runtime.catalog.current() : [], visible)
    if (fingerprint === runtime.publishedCatalog) return
    runtime.publishedCatalog = fingerprint
    notifyCatalogChanged(runtime.variant.id)
  }

  /**
   * 通知宿主「该 provider 的目录内容变了」，正在打开的客户端随之重拉模型列表。
   *
   * 为什么走 `handle.replace()`：客户端（dsh-client-ui-model-selection 的
   * `ModelCatalogDirectory`）只在四个远程事件上重拉目录，其中
   * `llm/adapters-updated` 是我们能触发的那个；而它**缓存命中即直接返回**，
   * 收不到事件就一直展示打开页面那一刻的旧名单，直到用户刷新页面。
   * 该事件由 `dsh-llm` 私有的 `emitAdaptersUpdated` 发布，插件不能直接调——但
   * `AdapterRegistrationHandle.replace` 的 JSDoc 明说路由集唯一的变更点正是
   * 发布该事件的地方，所以"用同样的路由替换自己"就是公开的正式通知手段
   * （空数组也是合法替换，而初始注册不接受空列表）。**不要另造事件**。
   *
   * 容错：插件卸载、或注册与通知之间的竞态，都会让 `replace` 抛
   * `LlmError REGISTRATION_DISPOSED`（注册已释放，路由没了）。这是正常路径，
   * 吞掉即可——为一次目录通知打断 refreshCatalog 才是错的。
   */
  function notifyCatalogChanged(provider: string): void {
    // shim 还没监听、或注册已释放：这条目录等注册那次通知自己可见，不额外补一发。
    const handle = adapterHandles.get(provider)
    if (handle === undefined) return
    try {
      handle.replace([provider])
    } catch (error: unknown) {
      ctx.logger?.debug?.(`dsh-any-connect: ${provider} adapter registration is gone; catalog update not announced: ${error instanceof Error ? error.message : String(error)}`)
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
        ...variantIsStartPlan(runtime.variant) ? { fetchStartPlanClaim: claimPreviewFor(runtime) } : {},
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
        // 夜间免费是 Coding Plan 的权益，Start Plan 不享受。两个 ZCode 变体
        // 是独立产品，各自的凭据 transform 已固定 zcodePlan，资格随之而定。
        if (variant.kind === 'zcode') {
          catalog.setNightFreeEligible(
            (credential as unknown as { zcodePlan?: ZCodePlanKind }).zcodePlan !== 'start-plan',
          )
        }
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
            // saved 可能由**旧版本**写入（那时还没有产品面白名单），启动时会先于
            // live 拉取发布——实测 2026-10-08：升级用户的 saved 里躺着 11 个
            // Coding Plan 模型，而客户端只提供 2 个，用户会先看到一整屏越界模型。
            // 这里用与 live 同一份白名单过滤；白名单不可得则原样发布（宁可按
            // saved 展示，也不因读不到客户端文件而抹掉整组）。Start Plan 不走
            // 这条：它的 saved 是 entitlements 派生的名单，语义不同。
            const savedModels = variant.kind === 'zcode' && !variantIsStartPlan(variant)
              ? filterByCodingPlanWhitelist(saved.models, (runtime.client as ZCodeUpstreamClient | undefined)?.codingPlanWhitelist?.())
              : saved.models
            catalog.set([...savedModels])
            runtime.catalogSource = 'saved'
            runtime.catalogFetchedAtMs = saved.fetchedAtMs
          } else {
            catalog.set(fallbackFor(variant))
            runtime.catalogSource = 'fallback'
            runtime.catalogFetchedAtMs = undefined
          }
          runtime.catalogError = undefined
          // 这一拍是 saved/fallback 先行发布，不是上游的答案：空名单说明只对
          // 「live 拉取成功但零模型」成立，随后那次 live 会自己改写它。
          runtime.catalogEmpty = false
          catalog.setVisible(true)
          publishCatalog(runtime)
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
        // 本次刷新真正落到用户眼前的那一行：内容变了才通知宿主（见 publishCatalog）。
        publishCatalog(runtime)
        runtime.catalogSource = 'live'
        runtime.catalogFetchedAtMs = Date.now()
        runtime.catalogError = undefined
        // 上游明确答「什么都没有」：这不是错误，是要如实说出来的结论。
        runtime.catalogEmpty = models.length === 0
        // 空名单是**有效的降级观测**（Start Plan 今日未领取/活动已过期：上游查询
        // 成功但没有任何有效活动），它只该影响本轮的 UI——空目录即 DSH 隐藏该分组。
        // 但它**不是可持久化的观测**：catalogStore 是"上次真正加载过的名单"，
        // 存下空名单会让下次启动的 saved 分支把空目录当已知好状态发布，一旦那时
        // live 拉取再失败（catch 停在 saved），用户就长期看不到这个分组——而这
        // 恰恰是 saved 存在的目的（重启后别落回内置名单）。所以空名单不写盘。
        if (models.length > 0) {
          await catalogStore!.save({
            account: identity,
            source: variant.kind === 'zcode' ? 'https://open.bigmodel.cn' : chatBase(credential as unknown as Parameters<typeof chatBase>[0]),
            fetchedAtMs: runtime.catalogFetchedAtMs,
            models: [...models],
          })
        }
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
        // 拉取失败 = 没拉到（保留上一份名单），不是「拉到了空的」。
        runtime.catalogEmpty = false
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
  // 清理必须以 Promise 形式交回 cordis：宿主与测试都在 await 卸载完成，
  // 而 fire-and-forget 的两处收尾（心跳删除、shim 关闭）会与调用方的后续
  // 动作竞态——表现为临时目录删除时 ENOTEMPTY（心跳文件刚被写/删），以及
  // 测试进程里残留的监听端口。返回 Promise 后 cordis 会等它落定。
  ctx.effect(() => async () => {
    stopped = true
    clearInterval(sweep)
    clearInterval(catalogTimer)
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
  // 身份与时段核对：只读 current()，身份没变就什么都不做（零上游请求）。
  // 时段交界处（夜间免费 23:00 / 09:00）自动重新同步 ZCode 目录。
  // 用 unref 的 interval，vitest 假时钟下 advanceTimers 会触发它——回调内
  // 无身份变化时不触网，现有重试计数测试不受影响。区域错配在这里静默隐藏
  // （原因已由 status 报给卡片），不每 60s 打一条告警。
  let lastOffpeak = isZCodeOffpeak()
  const sweep = setInterval(() => {
    if (stopped) return
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
          if (shouldRefresh && !stopped) {
            refreshCatalog(runtime, offpeakChanged ? 'offpeak boundary crossed' : 'identity sweep')
            return
          }
          // Start Plan「领取后恢复」快通道。见 claimFlipRefreshes。
          if (!stopped && await claimFlipChanged(runtime)) {
            refreshCatalog(runtime, 'start-plan claim flipped')
          } else if (!stopped && variantIsStartPlan(runtime.variant)
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
      refreshCatalog(runtime, 'scheduled refresh')
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
          publishCatalog(runtime)

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
