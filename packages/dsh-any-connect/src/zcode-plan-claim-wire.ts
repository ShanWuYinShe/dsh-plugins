/**
 * zcode-plan-claim-wire.ts — Start Plan **预览**的线上格式层（纯函数）。
 *
 * 2026-10-08 从 395 行的 zcode-plan-claim.ts 拆出：URL / 请求头构造与响应解析
 * 全是纯函数，与网络调用分开后可以单独喂样本测试；I/O 留在 zcode-plan-claim.ts。
 *
 * claim（POST 领取）的构造/解析已删除：captcha 只能由客户端渲染进程签发，
 * 纯 Node 侧无法完成领取，那条链从来没有生产调用方。
 *
 * @module dsh-any-connect/zcode-plan-claim-wire
 */

import { type StartPlanEntitlement } from './zcode-plan-models.js'
import { ERROR_BODY_LIMIT, JSON_TIMEOUT_MS } from './upstream-shared.js'
import { isObject } from './values.js'

export { ERROR_BODY_LIMIT }

export const ZCODE_ACCOUNT_BASE = 'https://zcode.z.ai'

/** JSON 端点统一 30s 超时（单一来源：upstream-shared.JSON_TIMEOUT_MS）。 */
export const CLAIM_TIMEOUT_MS = JSON_TIMEOUT_MS

/** 401/403 一律归为会话失效：换一次 captcha 也救不回来，得重新登录。 */
export const AUTH_FAILURE_CODES = new Set([1001, 1002, 401, 403])

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
