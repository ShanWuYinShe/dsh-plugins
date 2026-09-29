/**
 * ZCode 账号计划（Start Plan / off-peak）的额度读取。
 *
 * Start Plan 走的是 zcode.z.ai 上一条与 Coding Plan 直连完全不同的面：
 * 额度与套餐由 `/api/v1/zcode-plan/billing/balance` 下发（Bearer 账号 JWT +
 * `X-Device-Mid`），返回的是**按时段发放的包**而不是积分——每个包带
 * `show_name / total_units / used_units / remaining_units / expires_at`。
 *
 * 本模块只读取额度：模型请求（`/zcode-plan/anthropic`）当前被上游风控
 * 拦截（HTTP 405 code 3012，真客户端与浏览器内实测同样被拦），所以插件
 * 不对那条路径发请求——把额度与套餐报给用户，比暴露一个必然失败的模型
 * 分组诚实。
 *
 * @module dsh-any-connect/zcode-plan
 */

import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyCreditAccount, WorkBuddyCredits } from './upstream.js'

/** 计划额度接口；`app_version` 可选（实测带与不带都返回 200）。 */
export const ZCODE_PLAN_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance'

/** 额度接口超时：与其余上游 JSON 端点同口径（30s 响应头）。 */
const PLAN_REQUEST_TIMEOUT_MS = 30_000

/** 一个已发放的额度包（服务端 balances[] 的投影）。 */
export interface ZCodePlanBalance {
  /** 上游展示名，例如 `GLM-5.3-Flash`。 */
  showName: string
  totalUnits: number
  usedUnits: number
  remainingUnits: number
  /** 周期结束（epoch ms），服务端缺席时不出现。 */
  expiresAtMs?: number
}

/** 一个活动套餐（服务端 plans[] 的投影）。 */
export interface ZCodePlan {
  planId: string
  /** 活动名，例如 `ZCode Trust Build`。 */
  name: string
  status: string
  endsAtMs?: number
  balances: readonly ZCodePlanBalance[]
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** epoch 秒（服务端口径）→ epoch 毫秒。 */
function secondsToMs(value: unknown): number | undefined {
  const seconds = finiteNumber(value)
  return seconds === undefined || seconds <= 0 ? undefined : seconds * 1000
}

/**
 * 解析额度响应。响应形状以本机实测为准（2026-09-29，ZCode 3.14.4）：
 * `data.plans[]`（套餐与到期）、`data.balances[]`（每个额度包的用量）。
 * 任何一层不符合预期都返回 `undefined`——由调用方决定降级文案，而不是
 * 在这里编数字。
 */
export function parseZCodePlanCredits(payload: unknown): readonly ZCodePlan[] | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const document = payload as Record<string, unknown>
  if (document['code'] !== 0) return undefined
  const data = document['data']
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>

  const balances = Array.isArray(record['balances']) ? record['balances'] : []
  const byEntitlement = new Map<string, ZCodePlanBalance>()
  for (const entry of balances) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const showName = stringField(row['show_name'])
    const totalUnits = finiteNumber(row['total_units'])
    const remainingUnits = finiteNumber(row['remaining_units'])
    if (showName === undefined || totalUnits === undefined || remainingUnits === undefined) continue
    const balance: ZCodePlanBalance = {
      showName,
      totalUnits,
      usedUnits: finiteNumber(row['used_units']) ?? Math.max(0, totalUnits - remainingUnits),
      remainingUnits,
      ...secondsToMs(row['expires_at']) === undefined ? {} : { expiresAtMs: secondsToMs(row['expires_at'])! },
    }
    const entitlementId = stringField(row['entitlement_id'])
    if (entitlementId !== undefined) byEntitlement.set(entitlementId, balance)
  }

  const rawPlans = Array.isArray(record['plans']) ? record['plans'] : []
  const plans: ZCodePlan[] = []
  for (const entry of rawPlans) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const row = entry as Record<string, unknown>
    const planId = stringField(row['plan_id'])
    const name = stringField(row['name'])
    if (planId === undefined || name === undefined) continue
    const entitlements = Array.isArray(row['entitlements']) ? row['entitlements'] : []
    const matched: ZCodePlanBalance[] = []
    for (const entitlement of entitlements) {
      if (typeof entitlement !== 'object' || entitlement === null || Array.isArray(entitlement)) continue
      const id = stringField((entitlement as Record<string, unknown>)['entitlement_id'])
      const balance = id === undefined ? undefined : byEntitlement.get(id)
      if (balance !== undefined) matched.push(balance)
    }
    plans.push({
      planId,
      name,
      status: stringField(row['status']) ?? 'unknown',
      ...secondsToMs(row['ends_at']) === undefined ? {} : { endsAtMs: secondsToMs(row['ends_at'])! },
      balances: matched,
    })
  }
  return plans
}

/**
 * 把计划额度投影成插件统一的 credits 形状。
 *
 * 单位是 token，不是积分：这里只做形状适配，不改变数量口径。包名沿用上游
 * `showName`，planName 用活动名——两者都要如实显示，否则用户看到的额度
 * 归不到任何一个自己认识的套餐上。
 */
export function planCredits(plans: readonly ZCodePlan[]): WorkBuddyCredits {
  const accounts: WorkBuddyCreditAccount[] = []
  for (const plan of plans) {
    for (const balance of plan.balances) {
      accounts.push({
        packageName: balance.showName,
        planName: plan.name,
        remain: balance.remainingUnits,
        size: balance.totalUnits,
        ...balance.expiresAtMs === undefined ? {} : { expiredAt: new Date(balance.expiresAtMs).toISOString() },
      })
    }
  }
  return {
    total: accounts.reduce((sum, account) => sum + account.remain, 0),
    accounts,
  }
}

/**
 * 稳定设备 id（`X-Device-Mid`）：优先跟随 ZCode 桌面端注册的值，没有
 * 桌面端时自生成并持久化在 `$DSH_HOME`。服务端按这个 id 识别客户端，
 * 每次请求随机会让额度接口判为异常流量。
 */
export async function zcodeDeviceMid(): Promise<string> {
  try {
    const state = JSON.parse(await readFile(join(homedir(), '.zcode', 'v2', 'telemetry-state.json'), 'utf8')) as { deviceMid?: unknown }
    const registered = stringField(state.deviceMid)
    if (registered !== undefined) return registered
  } catch {
    // 桌面端未装/未注册：走自生成，下面的路径会给一个稳定值。
  }
  const path = join(resolveDshHome(), '.zcode-device-mid')
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (existing !== '') return existing
  } catch {
    // 首次运行：下面生成。
  }
  const mid = randomUUID()
  try {
    await writeFile(path, `${mid}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 落盘失败不影响本次使用（下次会换一个 id，仅影响指纹稳定性）。
  }
  return mid
}

/** 读额度所需的凭据：账号 JWT 与一个稳定设备 id。 */
export interface ZCodePlanQueryOptions {
  /** 账号 JWT（`zcodejwttoken`）。 */
  jwt: string
  /** 覆盖设备 id（测试用）；默认取 {@link zcodeDeviceMid}。 */
  deviceMid?: string
  /** 覆盖 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /** 上游响应头超时；默认 30s。 */
  timeoutMs?: number
}

/**
 * 读取当前账号的 Start Plan 额度。
 *
 * 失败一律抛出（调用方转成卡片的 error 文案）：额度是页面上唯一的实时
 * 数字，"读不到"与"用完了"必须能区分。
 */
export async function fetchZCodePlanCredits(options: ZCodePlanQueryOptions): Promise<WorkBuddyCredits> {
  const deviceMid = options.deviceMid ?? await zcodeDeviceMid()
  const fetchImpl = options.fetchImpl ?? fetch
  const url = new URL(ZCODE_PLAN_BALANCE_URL)
  url.searchParams.set('app_version', '3.14.4')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PLAN_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        'Authorization': `Bearer ${options.jwt}`,
        'X-Device-Mid': deviceMid,
        'Accept': 'application/json',
      },
      signal: controller.signal,
    })
  } catch (error: unknown) {
    throw new Error(`ZCode plan quota unreachable: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    throw new Error(`ZCode plan quota request failed: HTTP ${response.status}`)
  }
  const plans = parseZCodePlanCredits(await response.json())
  if (plans === undefined) throw new Error('ZCode plan quota response was not understood')
  return planCredits(plans)
}
