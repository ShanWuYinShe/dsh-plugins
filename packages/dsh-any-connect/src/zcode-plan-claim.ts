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
 *     验证后完成，所以插件根本没有「自动领取」动作（claim POST 的构造/解析
 *     已删除；未来若做浏览器态再随功能加回）。
 *   - 因此本模块对外只暴露 `previewStartPlan`：探测自动、领取手动。
 *
 * @module dsh-any-connect/zcode-plan-claim
 */

import { deadlineSignal } from './timeout.js'
import { httpStatusLabel } from './upstream-shared.js'
import { errorMessage } from './values.js'
import {
  CLAIM_TIMEOUT_MS,
  ERROR_BODY_LIMIT,
  AUTH_FAILURE_CODES,
  upstreamCode,
  upstreamMessage,
  parseErrorCode,
  buildPreviewUrl,
  buildPreviewHeaders,
  parsePreviewBody,
} from './zcode-plan-claim-wire.js'
import type {
  StartPlanClaimCredential,
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
      return { status: 'auth-failed', message: `登录态已失效（${httpStatusLabel(response.status)}）` }
    }
    if (!response.ok) {
      const text = await readErrorBody(response)
      const code = parseErrorCode(text)
      if (code !== undefined && AUTH_FAILURE_CODES.has(code)) {
        return { status: 'auth-failed', message: `登录态已失效（code ${code}）` }
      }
      return { status: 'failed', message: `preview 失败（${httpStatusLabel(response.status)}）` }
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
    return { status: 'failed', message: errorMessage(error) }
  } finally {
    handle.dispose()
  }
}

// 线上格式层已搬到 zcode-plan-claim-wire.ts：在这里再导出公开面（index.ts 与测试的导入路径不变）。
export {
  upstreamCode,
  upstreamMessage,
  parseErrorCode,
  buildPreviewUrl,
  buildPreviewHeaders,
  parsePreviewBody,
} from './zcode-plan-claim-wire.js'
export type {
  StartPlanClaimCredential,
  StartPlanPreviewItem,
  StartPlanPreviewResult,
  StartPlanPlatformInfo,
} from './zcode-plan-claim-wire.js'
