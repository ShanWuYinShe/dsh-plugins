import type { WorkBuddyCredential } from './auth.js'
import { resolveAppVersion, type AppVersionInfo } from './app-version.js'
import type { ProbeAttempt } from './probe.js'
import { deadlineSignal } from './timeout.js'
import { ZCodeClientSigner } from './zcode-signer.js'
import { readZcodeCodingPlanWhitelist } from './zcode-builtin-catalog.js'
import { parseCodingPlanQuota, type ZCodeCodingPlanQuota } from './zcode-quota.js'
import { type StartPlanPreviewResult } from './zcode-plan-claim.js'
import {
  JSON_TIMEOUT_MS,
  settleChatFetch,
  classifyUpstreamError,
  type WorkBuddyUpstreamModel,
  type WorkBuddyCreditAccount,
  type WorkBuddyCredits,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyChatResult,
} from './upstream-shared.js'
import type { ZCodeStartPlanContext } from './upstream-zcode-start-plan.js'
import { chatStreamStartPlan, fetchStartPlanModels, fetchStartPlanClaimPreview, fetchStartPlanCredits } from './upstream-zcode-start-plan.js'
import { defaultZCodeModelInfo, prepareAnthropicBody } from './upstream-zcode-body.js'
import { CODING_PLAN_FALLBACK_CREDITS, codingPlanCreditsFrom, mergeZCodeCatalogue } from './upstream-zcode-normalize.js'

/**
 * upstream-zcode.ts — ZCode 上游客户端（bigmodel 订阅通道 + Start Plan）。
 *
 * 2026-10-08 从 upstream.ts（1765 行）拆出：原文件同时装着两个产品的 wire 实现
 * 与共享协议层。现在按「共享协议层 / WorkBuddy / ZCode」三分，upstream.ts 退化为
 * re-export 门面，对外 API 不变。
 *
 * @module dsh-any-connect/upstream-zcode
 */

export interface ZCodeUpstreamClientOptions {
  signer?: ZCodeClientSigner
  models?: readonly WorkBuddyUpstreamModel[]
  /** Resolves the client app version sent as `app_version`/`X-ZCode-App-Version`
   * on the account-plan endpoints; injectable so tests never touch the real FS. */
  resolveAppVersion?: () => Promise<AppVersionInfo>
  /** Coding Plan 的官方模型白名单（小写 id 集合）；undefined = 客户端产品面不可得。
   * 默认实现读本机 ZCode 客户端的 zcode-builtin.json（见 zcode-builtin-catalog），
   * 注入口让测试不依赖测试机的真实安装。 */
  resolveCodingPlanWhitelist?: () => ReadonlySet<string> | undefined
}

/**
 * ZCode upstream client: client request signing V4 handshake and per-request
 * signing for BigModel Coding Plan, streaming chat completions, model list,
 * and subscription quota.
 */
export class ZCodeUpstreamClient {
  private readonly signer: ZCodeClientSigner
  private readonly models: readonly WorkBuddyUpstreamModel[]
  private readonly resolveAppVersion: () => Promise<AppVersionInfo>
  private readonly resolveCodingPlanWhitelist: () => ReadonlySet<string> | undefined

  constructor(options: ZCodeUpstreamClientOptions = {}) {
    this.signer = options.signer ?? new ZCodeClientSigner()
    this.models = options.models ?? []
    this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion())
    this.resolveCodingPlanWhitelist = options.resolveCodingPlanWhitelist ?? readZcodeCodingPlanWhitelist
  }

  /** Start Plan 通道的上下文：只把真正需要的两个字段递出去（其余是模块级助手）。 */
  private startPlanContext(): ZCodeStartPlanContext {
    return { models: this.models, resolveAppVersion: this.resolveAppVersion }
  }

  /**
   * 当前客户端内置目录给出的 Coding Plan 白名单（小写 id 集合），不可得时
   * undefined。公开出来供启动时过滤历史 saved 目录——旧版本写入的 saved 可能
   * 含产品面之外的模型（见 `filterByCodingPlanWhitelist`）。
   */
  codingPlanWhitelist(): ReadonlySet<string> | undefined {
    return this.resolveCodingPlanWhitelist()
  }

  /**
   * Coding Plan 的窗口额度（5 小时 / 7 天 / 工具调用），来自客户端用的同一支
   * `GET https://bigmodel.cn/api/monitor/usage/quota/limit`（Authorization 用
   * coding-plan 的 api-key）。拿不到（网络/非 bigmodel 账号/形状变化）返回
   * undefined，调用方回退到订阅有效性窗口——绝不编数字。
   */
  async fetchCodingPlanQuota(credential: WorkBuddyCredential): Promise<ZCodeCodingPlanQuota | undefined> {
    const quotaTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://bigmodel.cn/api/monitor/usage/quota/limit', {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
        },
        signal: quotaTimeout.signal,
      })
      if (!response.ok) return undefined
      return parseCodingPlanQuota(await response.json())
    } catch {
      return undefined
    } finally {
      quotaTimeout.dispose()
    }
  }

  /** POST the BigModel Anthropic messages endpoint; a successful answer is the raw SSE response.
   *
   * 生效计划为 Start Plan 时走其专属通道（zcode-plan/anthropic + 账号 JWT），
   * 额度扣 Start Plan 专属余额——普通通道扣的是 Coding Plan 订阅，两者绝不
   * 混用（2026-09-30 口径）。 */
  async chatStream(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    if (credential.zcodePlan === 'start-plan') {
      return this.chatStreamStartPlan(credential, bodyJson, signal)
    }
    // 传输骨架（超时/释放/取消分类）见 settleChatFetch：三处 chat 共用一份，改一处即三处。
    const settled = await settleChatFetch(signal, async (fetchSignal) => {
      const zcodeHeaders = await this.signer.buildHeaders({ apiKey: credential.accessToken })
      return fetch('https://open.bigmodel.cn/api/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          ...zcodeHeaders,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'anthropic-version': '2023-06-01',
        },
        body: prepareAnthropicBody(bodyJson),
        signal: fetchSignal,
      })
    })
    if (settled.settled) return settled.result
    const { response, text } = settled
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  async fetchModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    // Start Plan 的名单以**当前活动的 entitlements** 为准，而不是客户端内置目录：
    // 内置目录只是候选，服务端按活动放行（实测 Trust Build 只授权 GLM-5.3-Flash，
    // 另外两个 400 code 3006 model not allowed）。拿不到授权信息时回退已注册名单
    // ——一次上游抖动不该让整组模型从选择器里消失。
    if (credential.zcodePlan === 'start-plan') {
      return this.fetchStartPlanModels(credential)
    }
    // Coding Plan 的名单真源是客户端内置 provider 目录（产品面），不是开放平台的
    // paas 目录：白名单拿不到（客户端未装/结构演进）就回已注册名单，不把未经验证
    // 的模型带进选择器（端点放行 ≠ 订阅覆盖，2026-10-06 实测见 zcode-builtin-catalog）。
    const whitelist = this.resolveCodingPlanWhitelist()
    if (whitelist === undefined) {
      return this.models
    }
    // 超时同样走宿主 deadline：外层 try/catch 的降级语义（失败回退已有模型）不变。
    const modelsTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://open.bigmodel.cn/api/paas/v4/models', {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
        },
        signal: modelsTimeout.signal,
      })
      if (!response.ok) {
        return this.models
      }
      const json = await response.json() as { data?: Array<{ id?: string }> }
      const upstreamIds = Array.isArray(json.data)
        ? json.data.map(row => typeof row?.id === 'string' ? row.id.trim() : '').filter(id => id !== '')
        : []
      if (upstreamIds.length === 0) {
        return this.models
      }
      // BigModel connection and API credentials verified; Coding Plan subscriber
      // models are preserved with their verified parameters (128K max tokens, custom rates).
      //
      // 三方合流，白名单是总闸：
      // - 上游 paas 目录给"开放平台有哪些 id"，只作存在性参考；id 必须先过客户端
      //   产品面白名单，官方未收录的模型不展示——那不是本订阅的名单；
      // - 白名单内的 id：本地收录过的沿用整行（128K/费率/徽章都不丢），没收录过
      //   的走保守默认（官方上新时新模型能出现，但不虚报窗口与费率）；
      // - 本地收录、上游没列的：仍在白名单内才保留（目录接口可能只列一部分；
      //   官方从产品面下架的模型则随之消失，不再靠本地行续命）。
      // 失败/空响应仍回退 this.models（上面的 return），语义不变。
      return mergeZCodeCatalogue(this.models, upstreamIds, whitelist)
    } catch {
      return this.models
    } finally {
      modelsTimeout.dispose()
    }
  }

  /**
   * Start Plan 专属通道：`zcode-plan/anthropic` + 账号 JWT（`zcodejwttoken`）
   * + 设备号。额度扣 Start Plan 专属余额（一次性、当日有效），与 Coding Plan
   * 订阅互不占用。
   *
   * 该通道校验**请求体指纹**：`system` 必须以官方客户端的固定提示词开头
   * （见 `zcode-plan-prompt` 与其中的实测记录），否则一律 405 `code 3012`。
   * 指纹是请求体内容，与传输层/请求头/签名无关，所以这里把指纹前置、把
   * Harness 自己的 system 提示词接在其后——实测模型仍按后者回答。仍被拦
   * （例如上游又加了新条件）时如实报错，绝不回落到普通通道，那会把请求偷偷
   * 记到 Coding Plan 头上。
   */
  private async chatStreamStartPlan(
    credential: WorkBuddyCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyChatResult> {
    return chatStreamStartPlan(this.startPlanContext(), credential, bodyJson, signal)
  }

  async fetchCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    // 额度来源跟生效计划走：Start Plan 查专属余额（billing/balance，当日有效的
    // 一次性 token 包），其余计划查 coding-plan 订阅（subscription/list）。两个
    // 口径绝不混报——Start Plan 档显示订阅余额、或 Coding Plan 档显示专属余额，
    // 都会让用户对着错误的池子做决定。
    if (credential.zcodePlan === 'start-plan') {
      return this.fetchStartPlanCredits(credential)
    }
    // 额度口径以「账户上的 coding-plan 订阅」为准，与客户端选了哪条账号计划
    // 无关：模型请求本身就固定走 coding-plan 通道（Start Plan 的专属模型通道
    // 被上游风控封锁，本包按普通 ZCode 150% 额度使用），额度显示自然也要跟
    // 模型请求同一口径，否则卡片报的是一份用不上的余额。
    const creditsTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
    try {
      const response = await fetch('https://bigmodel.cn/api/biz/subscription/list', {
        headers: {
          'Authorization': `Bearer ${credential.accessToken}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        signal: creditsTimeout.signal,
      })
      if (!response.ok) {
        return CODING_PLAN_FALLBACK_CREDITS
      }
      const json = await response.json() as { code?: number; data?: Array<{ productName?: string; status?: string; expireTime?: number | string }> }
      return codingPlanCreditsFrom(json)
    } catch {
      return CODING_PLAN_FALLBACK_CREDITS
    } finally {
      creditsTimeout.dispose()
    }
  }

  /**
   * Start Plan 的模型名单：读当前活动（`billing/balance` 的 `data.plans[]`）
   * 的 entitlements，按活动实际放行的模型派生。
   *
   * 与 {@link fetchStartPlanCredits} 共用同一个端点但**语义不同**：那里问的是
   * 还剩多少额度、失败必须如实抛错；这里问的是"活动授权了哪些模型"。
   *
   * 三种状态必须分开（混在一起就是"过期活动仍列出未授权模型"那个 bug）：
   * - 查到活动且解析出模型 -> 返回该名单；
   * - 查询**成功**但没有有效活动（未领取/已过期）-> 返回**空名单**，分组如实隐藏；
   * - 查询**失败**（HTTP 非 ok / 抛错）-> 回退已注册名单 this.models，一次上游
   *   抖动不该让用户失去一个本来能用的分组。
   *
   * **有有效活动但一个模型都解析不出来同样返回空名单**：走到那一步已经确认活动
   * 存在且有效，名单的权威来源就是它的 entitlements；此时若回退 this.models（对
   * start-plan 变体就是兜底那三个模型），等于让授权字段漂移重新长出"看起来能用、
   * 一用就 400 code 3006"的幻影名单——与"未领取却显示模型"是同一个用户可见症状。
   * 空名单 = "今天拿不到"（可恢复），幻影名单 = "以为能用"（更糟）。
   */
  private async fetchStartPlanModels(credential: WorkBuddyCredential): Promise<readonly WorkBuddyUpstreamModel[]> {
    return fetchStartPlanModels(this.startPlanContext(), credential)
  }

  /**
   * 今日 Start Plan 待领取探测（`billing/preview`）：纯 HTTP、**不需要验证码**，
   * 因此可以自动跑。返回的清单就是"今天还能领什么"，为空表示今日已领取。
   *
   * 这是**提示性**信息，不是额度也不是名单，所以失败语义照 {@link fetchStartPlanModels}：
   * 绝不抛错（探不到就让调用方按 unknown 处理），也绝不因此影响分组可用性——
   * 探测失败不该让用户失去一个本来能用的连接。
   *
   * 接入点说明（能力边界）：本方法只做 preview。真正的 claim 需要
   * `X-Aliyun-Captcha-Verify-Param`，该 token 由客户端渲染进程的阿里云 SDK
   * 签发、与浏览器指纹绑定，纯 Node 侧无法生成（实测无 captcha 一律 400
   * code 3007），所以**全自动领取做不到**——插件做到的是"自动探测 + 提示用户
   * 去客户端点一次领取"，见 `zcode-plan-claim` 模块头部。
   *
   * `options.signal` 用于把本探测**限制在很短的窗口内**：status 路由是卡片每
   * 60s 轮询的读路径，一个挂死的上游不能把 status 拖住。超时/取消都会落进
   * catch，降级成 failed。
   */
  async fetchStartPlanClaimPreview(
    credential: WorkBuddyCredential,
    options: { signal?: AbortSignal } = {},
  ): Promise<StartPlanPreviewResult> {
    return fetchStartPlanClaimPreview(this.startPlanContext(), credential, options)
  }

  /**
   * Start Plan 专属额度（`billing/balance`）：`data.plans[]` 给活动名与有效期
   * （一次性包，当日过期），`data.balances[]` 给 token 级的总量/已用/剩余。
   * 查询失败如实抛错（卡片转 creditsError），绝不拿 Coding Plan 的订阅状态
   * 冒充 Start Plan 的额度。
   */
  private async fetchStartPlanCredits(credential: WorkBuddyCredential): Promise<WorkBuddyCredits> {
    return fetchStartPlanCredits(this.startPlanContext(), credential)
  }

  async refreshToken(credential: WorkBuddyCredential): Promise<WorkBuddyRefreshOutcome> {
    return { accessToken: credential.accessToken }
  }

  async probeEffort(
    _credential: WorkBuddyCredential,
    _model: string,
    _effort: string | undefined,
    _signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    return { status: 200, streamed: true }
  }
}

// 门面（upstream.ts）从本模块取 prepareAnthropicBody：搬走后在这里再导出一次。
export { prepareAnthropicBody } from './upstream-zcode-body.js'
