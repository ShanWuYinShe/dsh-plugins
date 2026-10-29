/**
 * The `workbuddy` pi-ai provider: one loopback-backed adapter registered
 * into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
 * extension points the way `dsh-codex-connect` assembles its Codex route.
 *
 * @module dsh-any-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelBadge, LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyCredentialStore } from './auth.js'
import type { WorkBuddyCatalog, WorkBuddyModelInfo } from './catalog.js'
import type { WorkBuddyProbeRecord } from './probe-store.js'
import type { WorkBuddyShim } from './shim.js'
import { normalizeCredits } from './upstream.js'

/** Provider route this bundle owns. */
const WORKBUDDY_PROVIDER = 'workbuddy'

/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Image-request budgets at the dsh-llm-pi-ai defaults; the profile type
 * requires them. They bound requests to models whose catalog
 * entry declares `supportsImages`; text-only models never receive images.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Inert pi-ai auth plane. The workbuddy route authenticates only through the
 * shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it. `PiAiAdapterOptions.auth` is required;
 * every ambient question here answers "nothing stored, nothing set".
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-any-connect: the workbuddy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * The suffix appended to a model's display name so its billing rate is visible
 * wherever the name is shown.
 *
 * The separator is a middle dot rather than a hyphen or colon: model names
 * already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
 * separator would be ambiguous about where the name ends and the rate begins.
 */
const RATE_SEPARATOR = ' · '

/**
 * The billing facts both display surfaces are built from.
 *
 * Display-only and cannot affect routing: the wire request is built from
 * `model.id` (pi-ai's completions API sets `model: model.id`), the selection a
 * picker submits is `{provider, model: id, reasoningEffort}`, and `dsh-llm`
 * validates `name` as a non-empty string without comparing its contents.
 * Nothing in the host resolves a model *by* name.
 */
interface BillingFacts {
  /** Upstream says the model is free right now. */
  free: boolean
  /** Upstream promotion label (`限时免费` / `夜间折扣` …), when it declares one. */
  promo: string | undefined
  /** Credit multiplier (`x0.79`), when the catalog discloses it. */
  rate: string | undefined
}

/** Read the three billing facts once so both surfaces decide from the same input. */
function billingFacts(info: WorkBuddyModelInfo): BillingFacts {
  const promo = info.billing?.badges?.[0]
  return {
    free: info.billing?.free === true,
    promo: promo !== undefined && promo.length > 0 ? promo : undefined,
    rate: normalizeCredits(info.billing?.credits),
  }
}

/**
 * Append the billing rate to one model's display name.
 *
 * The rate rides the *name* rather than only `description` because the DSH
 * model surfaces disagree about which field they render: the `/model` popup
 * builds its rows from `model.name` alone and never reads `description`.
 * Carrying the rate on the name makes it visible in both.
 *
 * The suffix deliberately carries only free/rate — not the promotion label:
 * the name is also what `/model` and the session metadata show, and the promo
 * label is a selector-only decoration (it lives in the native badge instead).
 *
 * @param name - display name the catalog handed in.
 * @param info - that model's catalog entry.
 * @returns the name with its billing suffix, or the bare base name.
 */
function withRate(name: string, info: WorkBuddyModelInfo): string {
  const baseName = name.split(RATE_SEPARATOR)[0] ?? name
  const { free, rate } = billingFacts(info)
  if (free) return `${baseName}${RATE_SEPARATOR}免费`
  return rate === undefined ? baseName : `${baseName}${RATE_SEPARATOR}${rate}`
}

/** Constructor dependencies. */
export interface WorkBuddyAdapterOptions {
  shim: WorkBuddyShim
  /** Unused since the shim took over credential resolution; kept optional for callers. */
  store?: WorkBuddyCredentialStore
  catalog: WorkBuddyCatalog
  /** Provider id and display name; default to the CN `workbuddy` route. */
  providerId?: string
  displayName?: string
  /**
   * Wire API between pi-ai and the shim. `openai-completions` (default) is
   * the WorkBuddy shape.
   * The model `baseUrl` matches: the OpenAI SDK appends `/chat/completions`
   * to `baseURL` (so the shim's `/v1` prefix rides inside baseUrl), while
   * the Anthropic SDK posts to `{baseURL}/v1/messages` (so baseUrl is the
   * shim root).
   */
  api?: 'openai-completions' | 'anthropic-messages'
  /** Probe observation consulted for undeclared models; a declared set always wins. */
  recordFor?: (modelId: string) => Pick<WorkBuddyProbeRecord, 'validation' | 'efforts'> | undefined
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
}

/** What {@link createWorkBuddyAdapter} hands back. */
export interface WorkBuddyAdapter {
  adapter: PiAiAdapter
}

/**
 * Resolve a WorkBuddy model's reasoning capability into pi-ai's
 * `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
 * unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
 *
 * Three sources, strictly ordered:
 * - A model that declares explicit `supportedEfforts` offers exactly those —
 *   the declaration is authoritative and per-model (e.g. `glm-5.3` is
 *   low/high/max while `glm-5.2` declares none). An observation
 *   never widens or narrows a declared set.
 * - A model that declares none (the older `{effort, summary}` shape) offers
 *   its default effort — unless a probe observation verified which spellings
 *   the upstream actually accepts, in which case exactly those are offered.
 *   The upstream accepts any effort string on the wire without validating it
 *   (an invalid `"banana"` returns 200 just like everything else on several
 *   rows), and for these rows an unverified value demonstrably does not change
 *   behavior — offering a selectable ladder there would advertise control the
 *   upstream ignores.
 * - `off` never carries a wire spelling: the upstream rejects the string
 *   `off` (400 / code 11150) and pi-ai injects this entry into every request
 *   that omits an effort, so a string here breaks default calls (session
 *   titles, auto review) rather than only an explicit "off" pick. See the map
 *   below for the measurements.
 */
export function reasoningFields(
  info: WorkBuddyModelInfo,
  observed?: Pick<WorkBuddyProbeRecord, 'validation' | 'efforts'>,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const declared = reasoning.supportedEfforts !== undefined && reasoning.supportedEfforts.length > 0
    ? reasoning.supportedEfforts
    : undefined
  // Only a validating observation may supply a set, and only for rows the
  // upstream left undeclared. A `non-validating` observation deliberately
  // yields nothing: the upstream accepts values that cannot exist, so every
  // per-level acceptance it produced would be a false positive.
  const observedSet = observed?.validation === 'validating' && observed.efforts.length > 0
    ? observed.efforts
    : undefined
  const efforts: readonly string[] = declared ?? observedSet ?? [reasoning.defaultEffort ?? 'high']
  const map: Record<ModelThinkingLevel, string | null> = {
    // `off` 刻意不给 wire 拼写（2026-10-11 实测修正）。两条理由都是实测的：
    //
    // 1. pi-ai 的 openai-completions 分发把这个条目当作「未指定档位时要下发的
    //    值」（`!options?.reasoningEffort` → `reasoning_effort = thinkingLevelMap.off`）。
    //    所以这里放字符串，会被注入**每一条**默认请求——会话标题、auto review、
    //    任何不带 effort 的调用——而不只是用户显式选「Off」时。
    // 2. 上游拒绝 `off` 这个拼写（HTTP 400 / code 11150「the reasoning effort
    //    value is not supported by the current model」），而真正让模型不思考的
    //    做法是**不下发该字段**（同模型实测：不传 → 响应无 reasoning；传 high
    //    → 有）。也就是说原来的 'off' 字符串既买不到关闭思考，还让每条默认请求
    //    都吃一个 400。
    // 置 null 后：默认请求不带字段（上游默认行为），选择器也不再提供「Off」——
    // 在拿到**逐模型验证过**的关闭拼写之前，不展示做不到的控制。
    off: null,
    minimal: efforts.includes('minimal') ? 'minimal' : null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/**
 * Build one pi-ai model descriptor pointing at the loopback shim.
 *
 * Exported for the package's own contract tests（同包测试走相对路径 import，
 * 不经包入口——入口只保留 Loader 四导出）。不供宿主/其它包使用。
 */
export function toPiModel(
  info: WorkBuddyModelInfo,
  baseUrl: string,
  providerId: string,
  api: 'openai-completions' | 'anthropic-messages',
  observe?: (modelId: string) => Pick<WorkBuddyProbeRecord, 'validation' | 'efforts'> | undefined,
): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api,
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info, observe?.(info.id)),
    cost: NO_COST,
    // 容量必须显式声明：DSH 0.2.2 起「未声明容量的自定义模型」默认按十进制
    // 1M 上下文 / 128K 输出（release notes「其他变更」），本插件不能依赖那个
    // 默认值。目录每行都带真实容量——FALLBACK_* 常量、上游响应解析
    // （parseModelRow 对 maxInput/maxOutput 缺失或非正的行直接丢弃）、saved
    // 目录校验（catalog-store 的 isModel 要求两个字段是有限数字）、未知模型的
    // 保守默认（200K / 32K，见 defaultZCodeModelInfo / startPlanModelInfo）——
    // 所以这里透传即可；test/capacity.test.ts 锁住这条不变量。
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    // `compat` 是 pi-ai 的官方 `Model.compat`（openai-completions 通道取
    // `OpenAICompletionsCompat`，见 pi-ai 1.3.0+/dist/providers/compat-schema.d.ts），
    // 不是本仓自造的兼容字段：该分发在 `model.reasoning && compat.supportsDeveloperRole`
    // 为真时把系统提示词发成 `role: "developer"`，而 WorkBuddy 网关对该角色回
    // HTTP 400 code 11128，所以从源头上声明 `false` 让它发 `system`（shim 的
    // normalizeDeveloperRole 仍作为第二道防线兜住别处混入的 developer）。
    // anthropic-messages 协议没有 developer 角色（其 compat 类型里也没有这个
    // 字段），因此只对 OpenAI 形通道声明。
    ...api === 'openai-completions' ? { compat: { supportsDeveloperRole: false } } : {},
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
export function createWorkBuddyAdapter(options: WorkBuddyAdapterOptions): WorkBuddyAdapter {
  const { shim, catalog, resolveAttachments } = options
  const providerId = options.providerId ?? WORKBUDDY_PROVIDER
  const displayName = options.displayName ?? 'WorkBuddy'
  const api = options.api ?? 'openai-completions'

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL, so
    // the shim's routes line up with the `/v1` prefix in place; the Anthropic
    // SDK posts to `{baseURL}/v1/messages`, so its baseUrl is the shim root.
    const baseUrl = api === 'anthropic-messages' ? shim.baseUrl() : `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, providerId, api, options.recordFor))
  }

  const base = createProvider({
    id: providerId,
    name: displayName,
    auth: {
      apiKey: {
        name: 'WorkBuddy OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy' }
        },
      },
    },
    models: buildModels(),
    api: api === 'anthropic-messages' ? anthropicMessagesApi() : openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read (the reuse-catalog pattern from
  // dsh-llm-pi-ai): stream dispatch still runs through the constructed
  // provider, while the catalog answer tracks the upstream refresh.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-any-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    // 解析失败模型的诊断：本插件的 catalog 只含已成功解析
    // 的模型，无可保留的诊断，与宿主自身缺省一致传空 Map。
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  const profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new WorkBuddyPiAiAdapter(catalog, providerId, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    // Resolve the shim's per-process shared secret as the OpenAI apiKey so
    // pi-ai sends it as `Authorization: Bearer <shared-secret>`. The shim
    // validates this before forwarding and resolves the real WorkBuddy token
    // itself via the store, so the secret never reaches upstream.
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
  })

  return {
    adapter,
  }
}

/**
 * Short provider-authored badge for one model (DSH 0.2.2 `LlmModelInfo.badge`).
 *
 * Same decision as the name suffix — see {@link billingLabel} — re-encoded as
 * localized text plus a tone so the native selector can render it directly.
 *
 * @param info - that model's catalog entry.
 * @returns the badge, or undefined when the catalog discloses no billing data.
 */
export function modelBadge(info: WorkBuddyModelInfo): LlmModelBadge | undefined {
  const { free, promo, rate } = billingFacts(info)
  if (free) return { text: { en: 'Free', zh: '免费' }, tone: 'success' }
  if (promo !== undefined) return { text: { en: promo, zh: promo }, tone: 'info' }
  return rate === undefined ? undefined : { text: rate, tone: 'neutral' }
}

/**
 * The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
 * into the catalog answers it returns to the DSH model pickers.
 *
 * `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
 * from the pi-ai descriptors, which carry no billing fact, so the rate is
 * layered on here by looking the model up in the live catalog. Both overrides
 * delegate to `super` and then rewrite only the display fields, so streaming,
 * capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
 * implements them.
 *
 * A model missing from the catalog (an id the shim would serve but the last
 * upstream refresh did not list) falls through with its name untouched rather
 * than being dropped: catalog membership is advisory, and the seam tolerates
 * serving an unlisted id.
 */
class WorkBuddyPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: WorkBuddyCatalog,
    private readonly providerId: string,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): WorkBuddyModelInfo | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (provider !== this.providerId) return []
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      const badge = modelBadge(info)
      // The rate rides the display name only: surfaces that render name and
      // description side by side showed it twice when it also filled the
      // description, so the description stays untouched here.
      return {
        ...model,
        name: withRate(model.name, info),
        ...badge === undefined ? {} : { badge },
      }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    const badge = modelBadge(info)
    return {
      ...resolved,
      name: withRate(resolved.name, info),
      ...badge === undefined ? {} : { badge },
    }
  }
}
