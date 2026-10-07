/**
 * ZCode Start Plan 每日领取：probe + claim 的纯逻辑、请求构造与响应解析。
 *
 * ── 为什么不能全自动（硬约束，实测取证）────────────────────────────────────
 * ZCode 桌面客户端 App.asar（偏移 271347225）里的 `claimManualPlan` 走两条
 * 请求：
 *
 *   GET  /api/v1/zcode-plan/billing/preview?app_version=<v>&platform=<p>
 *        Authorization: Bearer <zcodejwttoken>
 *        -> data.plans[] = **今日可领取**清单（已领过则为空数组）
 *   POST /api/v1/zcode-plan/billing/claim
 *        Authorization: Bearer <zcodejwttoken>
 *        Content-Type: application/json
 *        X-Aliyun-Captcha-Verify-Param: <captchaVerifyParam>
 *        X-ZCode-App-Version: <v>
 *        X-Platform: <p>
 *        body: {"plan_id": "<id>"}
 *
 * claim 的 `captchaVerifyParam` 由阿里云验证码 SDK（渲染进程里的
 * `window.AliyunCaptcha`）产出：客户端调 `startTracelessVerification()` 拿
 * 无感验证 token 再随请求带上。**该 token 由阿里云服务端签发、与浏览器指纹
 * 绑定，纯 Node/HTTP 侧无法生成，也无法复用他人已签发的 token。**
 * 本机实测（2026-10-04）：不带该头 POST claim 一律
 * `HTTP 400 {"code":3007,"msg":"captcha verify failed"}`。
 *
 * 因此本模块的能力边界是**明确划定**的，不做任何伪装：
 *   - 能做的：探测 preview（纯 HTTP，无需 captcha），如实回报"今天有哪些可
 *     领取项"，供卡片提示用户一键前往客户端领取；
 *   - 不能做的：全自动 claim。带 captcha 的 claim 只能由用户在客户端点一次
 *     验证后完成。
 *   - 因此 {@link claimStartPlan} 在拿不到 captcha 时**不发请求**，直接返回
 *     `captcha-required` —— 这是被显式建模的一种结果，不是笼统的失败，更
 *     不会被伪装成"已领取"。
 *
 * @module dsh-any-connect/zcode-plan-claim
 */

import { deadlineSignal } from './timeout.js'
import type { StartPlanEntitlement } from './zcode-plan-models.js'
import {
  ZCODE_ACCOUNT_BASE,
  CLAIM_TIMEOUT_MS,
  ERROR_BODY_LIMIT,
  AUTH_FAILURE_CODES,
  upstreamCode,
  upstreamMessage,
  parseErrorCode,
  buildPreviewUrl,
  buildPreviewHeaders,
  parsePreviewBody,
  buildClaimBody,
  buildClaimHeaders,
  parseClaimResponse,
} from './zcode-plan-claim-wire.js'
import type {
  StartPlanClaimCredential,
  StartPlanClaimResult,
  StartPlanPreviewResult,
  StartPlanPlatformInfo,
} from './zcode-plan-claim-wire.js'


/** 账号计划端点基址（与 `billing/balance` 同域）。 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_LIMIT)
  } catch {
    return ''
  }
}

/** 探测今日可领取清单（纯 HTTP，无需 captcha）。 */
export async function previewStartPlan(
  credential: StartPlanClaimCredential,
  info: StartPlanPlatformInfo,
  signal?: AbortSignal,
): Promise<StartPlanPreviewResult> {
  if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
    return { status: 'auth-failed', message: '缺少 zcodejwttoken（请在 ZCode 客户端登录一次）' }
  }
  const handle = await deadlineSignal(signal, CLAIM_TIMEOUT_MS, 'ANY_CONNECT_JSON')
  try {
    const response = await fetch(buildPreviewUrl(info), {
      headers: buildPreviewHeaders(credential),
      signal: handle.signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { status: 'auth-failed', message: `登录态已失效（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      const text = await readErrorBody(response)
      const code = parseErrorCode(text)
      if (code !== undefined && AUTH_FAILURE_CODES.has(code)) {
        return { status: 'auth-failed', message: `登录态已失效（code ${code}）` }
      }
      return { status: 'failed', message: `preview 失败（HTTP ${response.status}）` }
    }
    const body: unknown = await response.json()
    const code = upstreamCode(body)
    if (code !== 0) {
      if (AUTH_FAILURE_CODES.has(code)) {
        return { status: 'auth-failed', message: upstreamMessage(body) || `登录态已失效（code ${code}）` }
      }
      return { status: 'failed', message: `preview 返回 code ${code}: ${upstreamMessage(body)}` }
    }
    // plans 为空是合法结果（今日已领取），由调用方渲染成"无待领取"。
    return { status: 'ok', plans: parsePreviewBody(body) }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  } finally {
    handle.dispose()
  }
}

/**
 * 尝试领取一项 Start Plan。
 *
 * **没有 captcha 就不发请求。** 实测无 captcha 的 claim 必然 HTTP 400 code
 * 3007，发出去的请求只会白跑一趟、还可能被上游当成异常调用计数，所以这里
 * 直接短路成 `captcha-required`，把"需要用户点一次验证"这个结论如实交回给
 * 调用方。全自动领取在纯 HTTP 下**不可能**，这是本模块的核心结论。
 *
 * `captchaVerifyParam` 只有在调用方确实从渲染进程/用户会话里拿到了有效 token
 * 时才传入（例如未来的浏览器态实现），否则永远走 `captcha-required` 分支。
 */
export async function claimStartPlan(
  credential: StartPlanClaimCredential,
  info: StartPlanPlatformInfo,
  planId: string,
  captchaVerifyParam?: string,
  signal?: AbortSignal,
): Promise<StartPlanClaimResult> {
  if (credential.zcodeJwtToken === undefined || credential.zcodeJwtToken === '') {
    return { status: 'auth-failed', message: '缺少 zcodejwttoken（请在 ZCode 客户端登录一次）' }
  }
  const trimmedPlanId = planId.trim()
  if (trimmedPlanId === '') {
    return { status: 'failed', message: 'plan_id 为空，无法领取' }
  }
  const captcha = captchaVerifyParam?.trim() ?? ''
  if (captcha === '') {
    return {
      status: 'captcha-required',
      planId: trimmedPlanId,
      message: 'ZCode 领取需要阿里云验证码（X-Aliyun-Captcha-Verify-Param），'
        + '该 token 由客户端渲染进程的 window.AliyunCaptcha 签发、与浏览器指纹绑定，'
        + '纯 Node 侧无法生成；请在 ZCode 客户端点一次「领取」完成验证。',
    }
  }
  const handle = await deadlineSignal(signal, CLAIM_TIMEOUT_MS, 'ANY_CONNECT_JSON')
  try {
    const response = await fetch(`${ZCODE_ACCOUNT_BASE}/api/v1/zcode-plan/billing/claim`, {
      method: 'POST',
      headers: buildClaimHeaders(credential, info, captcha),
      body: buildClaimBody(trimmedPlanId),
      signal: handle.signal,
    })
    let body: unknown
    if (response.ok) {
      try {
        body = await response.json()
      } catch {
        return { status: 'failed', message: `claim 响应不是 JSON（HTTP ${response.status}）` }
      }
    } else {
      const text = await readErrorBody(response)
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
    }
    const parsed = parseClaimResponse(response.status, body)
    // captcha-rejected 的 planId 由响应体推不出来（那个分支只有错误码），
    // 这里补上调用方请求的那一项，卡片才能准确指认是哪个计划要重试。
    if (parsed.status === 'captcha-rejected') return { ...parsed, planId: trimmedPlanId }
    return parsed
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  } finally {
    handle.dispose()
  }
}

/**
 * 「一键领取」路径：探测 + 就绪时的结果汇总。
 *
 * 这是插件真正能提供的自动化上限——**探测自动、领取手动**。返回的
 * `claim` 字段在无 captcha 时必然是 `captcha-required`，上层据此在卡片上
 * 渲染「今日 Start Plan 待领取：<name>（plan_id）」+ 跳转/复制入口，而不是
 * 显示一个会失败的"自动领取"按钮。
 */
export async function probeAndClaimStartPlan(
  credential: StartPlanClaimCredential,
  info: StartPlanPlatformInfo,
  options: { captchaVerifyParam?: string; signal?: AbortSignal } = {},
): Promise<{ preview: StartPlanPreviewResult; claim?: StartPlanClaimResult }> {
  const preview = await previewStartPlan(credential, info, options.signal)
  if (preview.status !== 'ok' || preview.plans.length === 0) return { preview }
  const target = preview.plans[0]
  if (target === undefined) return { preview }
  const claim = await claimStartPlan(credential, info, target.planId, options.captchaVerifyParam, options.signal)
  return { preview, claim }
}

// 线上格式层已搬到 zcode-plan-claim-wire.ts：在这里再导出公开面（index.ts 与测试的导入路径不变）。
export {
  CAPTCHA_FAILED_CODE,
  upstreamCode,
  upstreamMessage,
  parseErrorCode,
  buildPreviewUrl,
  buildPreviewHeaders,
  parsePreviewBody,
  buildClaimBody,
  buildClaimHeaders,
  parseClaimResponse,
} from './zcode-plan-claim-wire.js'
export type {
  StartPlanClaimCredential,
  StartPlanPreviewItem,
  StartPlanClaimResult,
  StartPlanPreviewResult,
  StartPlanPlatformInfo,
} from './zcode-plan-claim-wire.js'
