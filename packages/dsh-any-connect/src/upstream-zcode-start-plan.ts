/**
 * upstream-zcode-start-plan.ts — Start Plan 通道（专属余额、活动名单与领取预览）。
 *
 * 2026-10-08 从 668 行的 upstream-zcode.ts 拆出：四个方法与客户端类解耦成带 ctx 的函数，
 * 类里保留同名方法作薄委托（调用点零改动）。依赖只有 models 与 resolveAppVersion 两项，
 * 其余都是模块级助手。
 *
 * @module dsh-any-connect/upstream-zcode-start-plan
 */

import type { WorkBuddyCredential } from './auth.js'
import { FALLBACK_APP_VERSION, resolveAppVersion } from './app-version.js'
import { deadlineSignal } from './timeout.js'
import { prepareStartPlanBody } from './zcode-plan-prompt.js'
import {
  FALLBACK_ZCODE_START_PLAN_MODELS,
  isStartPlanActivityActive,
  startPlanModelsFromEntitlements,
  type StartPlanActivity,
} from './zcode-plan-models.js'
import {
  previewStartPlan,
  type StartPlanClaimCredential,
  type StartPlanPlatformInfo,
  type StartPlanPreviewResult,
} from './zcode-plan-claim.js'
import {
  JSON_TIMEOUT_MS,
  settleChatFetch,
  classifyUpstreamError,
  type WorkBuddyUpstreamModel,
  type WorkBuddyCreditAccount,
  type WorkBuddyCredits,
  type WorkBuddyChatResult,
} from './upstream-shared.js'
import os from 'node:os'
import { prepareAnthropicBody } from './upstream-zcode-body.js'
import type { AppVersionInfo } from './app-version.js'

/** Start Plan 通道需要的客户端状态。 */
export interface ZCodeStartPlanContext {
  /** 兜底模型名单（白名单不可得或探测失败时返回它）。 */
  models: readonly WorkBuddyUpstreamModel[]
  /** 客户端 app 版本解析（部分端点要求 app_version）。 */
  resolveAppVersion: () => Promise<AppVersionInfo>
}

export async function chatStreamStartPlan(
  ctx: ZCodeStartPlanContext,
  credential: WorkBuddyCredential,
  bodyJson: string,
  signal?: AbortSignal,
): Promise<WorkBuddyChatResult> {
  if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
    return {
      ok: false,
      status: 0,
      kind: 'client',
      message: 'Start Plan 专属通道缺少凭据（凭据文档中没有 zcodejwttoken）——请在 ZCode 客户端登录一次后重试',
    }
  }
  // 传输骨架（超时/释放/取消分类）见 settleChatFetch：三处 chat 共用一份，改一处即三处。
  const settled = await settleChatFetch(signal, (fetchSignal) =>
    fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${credential.zcodeJwtToken}`,
        'X-Device-Mid': credential.zcodeDeviceMid ?? '',
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'anthropic-version': '2023-06-01',
      },
      body: prepareStartPlanBody(prepareAnthropicBody(bodyJson)),
      signal: fetchSignal,
    }),
  )
  if (settled.settled) return settled.result
  const { response, text } = settled
  if (text.includes('"code":3012')) {
    // 指纹已在请求体里（见 prepareStartPlanBody），走到这里说明上游改了判据
    // 或加了新条件——如实报告并说明"前置指纹仍不够"，不要谎称通道被封。
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: 'Start Plan 请求被上游风控拦截（code 3012），本次请求未消耗任何额度。'
        + '插件已按官方客户端的请求体指纹发送，仍被拦说明上游新增了判据——请报告此情况，不要改扣 Coding Plan。',
    }
  }
  if (response.status === 401) {
    return {
      ok: false,
      status: response.status,
      kind: 'client',
      message: 'Start Plan 凭据失效（HTTP 401）——请在 ZCode 客户端重新登录一次',
    }
  }
  return {
    ok: false,
    status: response.status,
    kind: classifyUpstreamError(response.status, text),
    message: text,
  }
}

export async function fetchStartPlanModels(
  ctx: ZCodeStartPlanContext,
  credential: WorkBuddyCredential,
): Promise<readonly WorkBuddyUpstreamModel[]> {
  if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
    return ctx.models
  }
  const modelsTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
  try {
    const response = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
      headers: {
        'Authorization': `Bearer ${credential.zcodeJwtToken}`,
        'X-Device-Mid': credential.zcodeDeviceMid ?? '',
        'Accept': 'application/json',
      },
      signal: modelsTimeout.signal,
    })
    if (!response.ok) return ctx.models
    const json = await response.json() as { data?: { plans?: readonly StartPlanActivity[] } }
    // 有效期以 ends_at（秒级 epoch）判定：过期活动放行的模型服务端已经不认，
    // 登记上去只会得到 400 code 3006 model not allowed。ends_at 缺失按有效处理。
    const now = Date.now()
    const active = (json.data?.plans ?? []).filter(plan => isStartPlanActivityActive(plan, now))
    if (active.length === 0) {
      // B：查询成功、但此刻没有任何有效活动（今天还没领取 / 活动已过期）——
      // 今日确实没有可用模型，返回空名单让分组隐藏。
      //
      // 这里**不再回退 ctx.models**：兜底名单里的 GLM-5.2 / GLM-5-Turbo 上游
      // 并不放行，选中只会失败（实测 400 code 3006），等于把"无模型"伪装成
      // "有三个模型"。分组隐藏后，用户重新领取活动即可恢复。
      return []
    }
    // 走到这里说明**已确认有有效活动**，名单的权威来源就是该活动的
    // entitlements：解析不出模型时返回空（分组隐藏），绝不回退 ctx.models。
    // 对 start-plan 变体而言 ctx.models 就是那三个幻影模型（index.ts 用
    // FALLBACK_ZCODE_START_PLAN_MODELS 构造 client），回退等于让"活动有效但
    // 授权字段漂移"重新长出"看起来能用、一用就 400 code 3006"的假名单。
    // 空 = "今天拿不到"（可恢复），幻影名单 = "以为能用"（更糟）。
    return startPlanModelsFromEntitlements(
      active.flatMap(plan => plan.entitlements ?? []),
      FALLBACK_ZCODE_START_PLAN_MODELS,
      true,
    )
  } catch {
    return ctx.models
  } finally {
    modelsTimeout.dispose()
  }
}

export async function fetchStartPlanClaimPreview(
  ctx: ZCodeStartPlanContext,
  credential: WorkBuddyCredential,
  options: { signal?: AbortSignal } = {},
): Promise<StartPlanPreviewResult> {
  const claimCredential: StartPlanClaimCredential = {
    ...credential.zcodeJwtToken === undefined ? {} : { zcodeJwtToken: credential.zcodeJwtToken },
    ...credential.zcodeDeviceMid === undefined ? {} : { zcodeDeviceMid: credential.zcodeDeviceMid },
  }
  // 平台拼法照抄 zcode-signer 的 'X-Platform'（`<os>-<arch>`），不另造一套；
  // 账号计划端点按它分流客户端版本，拼错会拿到与真客户端不同的响应。
  const platform = `${process.platform}-${os.arch()}`
  if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
    return { status: 'auth-failed', message: '未登录：凭据文档中没有 zcodejwttoken' }
  }
  let appVersion: string
  try {
    appVersion = (await ctx.resolveAppVersion()).version
  } catch {
    // 版本解析只影响查询参数与头，拿不到就走编译期兜底；让它把探测打挂
    // 是轻重倒置（与 WorkBuddyUpstreamClient.fetchModels 的降级同思路）。
    appVersion = FALLBACK_APP_VERSION
  }
  const info: StartPlanPlatformInfo = { appVersion, platform }
  return previewStartPlan(claimCredential, info, options.signal)
}

export async function fetchStartPlanCredits(
  ctx: ZCodeStartPlanContext,
  credential: WorkBuddyCredential,
): Promise<WorkBuddyCredits> {
  if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
    throw new Error('Start Plan 额度查询缺少凭据（凭据文档中没有 zcodejwttoken）')
  }
  const balanceTimeout = await deadlineSignal(undefined, JSON_TIMEOUT_MS, 'ANY_CONNECT_JSON')
  try {
    const response = await fetch('https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
      headers: {
        'Authorization': `Bearer ${credential.zcodeJwtToken}`,
        'X-Device-Mid': credential.zcodeDeviceMid ?? '',
        'Accept': 'application/json',
      },
      signal: balanceTimeout.signal,
    })
    if (!response.ok) {
      throw new Error(`Start Plan 额度查询失败（HTTP ${response.status}）`)
    }
    const json = await response.json() as {
      data?: {
        plans?: Array<{ name?: string; plan_id?: string; ends_at?: number }>
        balances?: Array<{
          show_name?: string
          plan_id?: string
          total_units?: number
          remaining_units?: number
          expires_at?: number
        }>
      }
    }
    const plans = json.data?.plans ?? []
    // 额度是**当日一次性池子**：活动当天发放、当天到期、余额不结转（实测
    // `period: "one_time"` + `expires_at` 固定当日 16:00Z）。所以卡片与 pill
    // 报的都是"这个池子此刻还剩多少"，而不是任何可累积的订阅余额。
    const accounts: WorkBuddyCreditAccount[] = (json.data?.balances ?? []).map(balance => {
      const plan = plans.find(entry => entry.plan_id !== undefined && entry.plan_id === balance.plan_id)
      let expiredAt: string | undefined
      if (typeof balance.expires_at === 'number' && balance.expires_at > 0) {
        const d = new Date(balance.expires_at * 1000)
        if (!Number.isNaN(d.getTime())) expiredAt = d.toISOString()
      }
      return {
        packageName: `${balance.show_name ?? 'Start Plan'} (有效)`,
        // 活动名（如 "ZCode Trust Build"）是用户看到的套餐名。
        planName: plan?.name ?? balance.show_name ?? 'Start Plan',
        // 该池子当日有效、不结转：到期时间就是它的"清零时刻"。
        sameDay: true,
        remain: typeof balance.remaining_units === 'number' ? balance.remaining_units : 0,
        size: typeof balance.total_units === 'number' ? balance.total_units : 0,
        ...expiredAt === undefined ? {} : { expiredAt },
      }
    })
    return {
      total: accounts.reduce((acc, cur) => acc + cur.remain, 0),
      accounts,
    }
  } finally {
    balanceTimeout.dispose()
  }
}
