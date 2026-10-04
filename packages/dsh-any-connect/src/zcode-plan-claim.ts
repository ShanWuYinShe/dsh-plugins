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

/** 账号计划端点基址（与 `billing/balance` 同域）。 */
const ZCODE_ACCOUNT_BASE = 'https://zcode.z.ai'

/** 与其余 JSON 端点的「响应头 30s」超时口径一致。 */
const CLAIM_TIMEOUT_MS = 30_000

/** 错误体读取上限，避免一个不健康的响应把内存吃掉。 */
const ERROR_BODY_LIMIT = 4096

/**
 * 上游的 captcha 失败码。实测不带 `X-Aliyun-Captcha-Verify-Param` 时返回
 * `HTTP 400 {"code":3007,"msg":"captcha verify failed"}`。
 */
export const CAPTCHA_FAILED_CODE = 3007

/** 401/403 一律归为会话失效：换一次 captcha 也救不回来，得重新登录。 */
const AUTH_FAILURE_CODES = new Set([1001, 1002, 401, 403])

/** claim 请求所需的凭据材料（只取用得到的两个字段，便于单测构造）。 */
export interface StartPlanClaimCredential {
  /** 凭据文档中解密出的 `zcodejwttoken`。 */
  zcodeJwtToken?: string
  /** 每台安装稳定的设备号；账号计划端点硬要求 `X-Device-Mid`。 */
  zcodeDeviceMid?: string
}

/** preview 里的一项「今日可领取」计划。 */
export interface StartPlanPreviewItem {
  planId: string
  name?: string
  priority?: number
  entitlements?: readonly StartPlanEntitlement[]
  /** 其他未建模的原始字段，原样保留供上层诊断。 */
  raw?: Record<string, unknown>
}

/**
 * 一次领取尝试的结果。**`captcha-required` 是一等公民**：它是"能领，但需
 * 要用户点一次验证码"这一确定状态，与"上游拒绝""网络失败""已登录过期"完全
 * 不同，卡片文案必须区别对待。
 */
export type StartPlanClaimResult =
  | { status: 'claimed'; planId: string; planName?: string }
  | { status: 'nothing-to-claim' }
  | { status: 'captcha-required'; planId: string; message: string }
  | { status: 'captcha-rejected'; planId: string; message: string }
  | { status: 'auth-failed'; message: string }
  | { status: 'failed'; message: string }

/** preview 探测结果：成功给清单，失败给可读原因（不让卡片静默空白）。 */
export type StartPlanPreviewResult =
  | { status: 'ok'; plans: readonly StartPlanPreviewItem[] }
  | { status: 'auth-failed'; message: string }
  | { status: 'failed'; message: string }

/** `platform` 查询参数取值：与 signer 的 `X-Platform` 同一拼法（`<os>-<arch>`）。 */
export interface StartPlanPlatformInfo {
  appVersion: string
  platform: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把上游的 `code` 归一成数字；缺失或非数字都算 0（HTTP 200 的常规成功体）。 */
export function upstreamCode(body: unknown): number {
  if (!isObject(body)) return 0
  const code = body['code']
  return typeof code === 'number' && Number.isFinite(code) ? code : 0
}

/** 上游的 `msg` / `message`，取不到时给空串（调用方自行兜底文案）。 */
export function upstreamMessage(body: unknown): string {
  if (!isObject(body)) return ''
  const msg = body['msg'] ?? body['message']
  return typeof msg === 'string' ? msg.trim() : ''
}

/** 解析出错响应体里的 `code`；体不是 JSON（或为空）时返回 undefined。 */
export function parseErrorCode(text: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed)) return undefined
    const code = parsed['code']
    if (typeof code === 'number' && Number.isFinite(code)) return code
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 构造 preview 的请求 URL。
 *
 * 两个查询参数都是客户端原样发送的：`app_version` 是客户端版本号，
 * `platform` 是 `<os>-<arch>`（与 signer 的 `X-Platform` 同拼法）。
 */
export function buildPreviewUrl(info: StartPlanPlatformInfo): string {
  const query = new URLSearchParams({ app_version: info.appVersion, platform: info.platform })
  return `${ZCODE_ACCOUNT_BASE}/api/v1/zcode-plan/billing/preview?${query.toString()}`
}

/** 构造 preview 的请求头：账号计划端点只需 Bearer JWT（preview 不要 captcha）。 */
export function buildPreviewHeaders(credential: StartPlanClaimCredential): Record<string, string> {
  return {
    'Authorization': `Bearer ${credential.zcodeJwtToken ?? ''}`,
    'X-Device-Mid': credential.zcodeDeviceMid ?? '',
    'Accept': 'application/json',
  }
}

/**
 * 解析 preview 响应体。
 *
 * 「今天没有可领取项」是**正常结果**（`data.plans: []`，实测今日已领过就是
 * 这个形状），所以它不是失败：返回空数组，由调用方渲染成"今日已领取"。
 * 无法识别成 plans 数组时同样给空数组——**绝不猜测**，宁可说"没有待领取"
 * 也不要凭空造出一项让用户点了却领不到。
 */
export function parsePreviewBody(body: unknown): readonly StartPlanPreviewItem[] {
  if (!isObject(body)) return []
  const data = body['data']
  if (!isObject(data)) return []
  const plans = data['plans']
  if (!Array.isArray(plans)) return []
  const items: StartPlanPreviewItem[] = []
  for (const entry of plans) {
    if (!isObject(entry)) continue
    const planId = entry['plan_id']
    if (typeof planId !== 'string' || planId.trim() === '') continue
    const name = entry['name']
    const priority = entry['priority']
    const entitlements = entry['entitlements']
    items.push({
      planId: planId.trim(),
      ...typeof name === 'string' && name.trim() !== '' ? { name: name.trim() } : {},
      ...typeof priority === 'number' && Number.isFinite(priority) ? { priority } : {},
      ...Array.isArray(entitlements) ? { entitlements: entitlements as readonly StartPlanEntitlement[] } : {},
      raw: entry,
    })
  }
  // 上游可能按优先级排列，但契约没有保证；按 priority 降序稳定排序，让
  // 「第一个」就是最该先领的那个（缺 priority 的排最后，保序）。
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.priority ?? -Infinity) - (a.item.priority ?? -Infinity) || a.index - b.index)
    .map(entry => entry.item)
}

/** 构造 claim 的请求体：上游只认 `plan_id`。 */
export function buildClaimBody(planId: string): string {
  return JSON.stringify({ plan_id: planId })
}

/**
 * 构造 claim 的请求头。
 *
 * `X-Aliyun-Captcha-Verify-Param` 是硬要求：阿里云 SDK 在渲染进程里签发、
 * 与浏览器指纹绑定，纯 Node 侧拿不到（见模块头部说明）。`captchaVerifyParam`
 * 为空时**仍然带上这个头**，让上游明确拒绝（实测 code 3007）——比悄悄漏掉
 * 一个头更容易对账，也避免"到底是没带还是带了没用"的歧义。
 */
export function buildClaimHeaders(
  credential: StartPlanClaimCredential,
  info: StartPlanPlatformInfo,
  captchaVerifyParam: string,
): Record<string, string> {
  return {
    'Authorization': `Bearer ${credential.zcodeJwtToken ?? ''}`,
    'Content-Type': 'application/json',
    'X-Aliyun-Captcha-Verify-Param': captchaVerifyParam,
    'X-ZCode-App-Version': info.appVersion,
    'X-Platform': info.platform,
    'X-Device-Mid': credential.zcodeDeviceMid ?? '',
    'Accept': 'application/json',
  }
}

/**
 * 解析 claim 响应。
 *
 * `httpStatus` 参与判定，因为 captcha 失败的真实形状是 **HTTP 400 + code
 * 3007**：只看 body 的 code 会漏掉"HTTP 层就已经被拒"的情况。`code 3007`
 * 单独映射为 {@link StartPlanClaimResult} 的 `captcha-rejected`——它是"验证
 * 码不对/过期"，与"压根没提供 captcha"（`captcha-required`）是两回事。
 */
export function parseClaimResponse(httpStatus: number, body: unknown): StartPlanClaimResult {
  const code = upstreamCode(body)
  const message = upstreamMessage(body)
  if (httpStatus === 401 || httpStatus === 403 || AUTH_FAILURE_CODES.has(code)) {
    return { status: 'auth-failed', message: message === '' ? `HTTP ${httpStatus}` : message }
  }
  if (code === CAPTCHA_FAILED_CODE) {
    return { status: 'captcha-rejected', planId: '', message: message === '' ? 'captcha verify failed' : message }
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { status: 'failed', message: message === '' ? `HTTP ${httpStatus}` : `HTTP ${httpStatus}: ${message}` }
  }
  if (code !== 0) {
    return { status: 'failed', message: message === '' ? `上游返回 code ${code}` : `code ${code}: ${message}` }
  }
  const data = isObject(body) ? body['data'] : undefined
  const plan = isObject(data) ? data['plan'] : undefined
  const planId = isObject(plan) && typeof plan['plan_id'] === 'string' ? plan['plan_id'].trim() : ''
  const planName = isObject(plan) && typeof plan['name'] === 'string' ? plan['name'].trim() : undefined
  return {
    status: 'claimed',
    planId,
    ...planName === undefined || planName === '' ? {} : { planName },
  }
}

/** 读取错误响应体文本；读失败不算失败原因，返回空串即可。 */
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
