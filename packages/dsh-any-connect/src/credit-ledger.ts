/**
 * credit-ledger.ts — WorkBuddy 积分消耗台账（采样差分统计）。
 *
 * 2026-10-26 起 WorkBuddy（CN 与 AI 两个变体）的额度是「裂变包」制：上游每天
 * 发一个新包（实测每个 100 积分、30 天有效），旧包到期后整包消失——「剩余/总额」
 * 因此每天都在双向跳动（新包 +100、消耗 -N、旧包到期 -整包），单看任何一个
 * 时刻的数字都读不出「今天花了多少」。
 *
 * 上游计费端点（POST /v2/billing/meter/get-user-resource）只有包级快照
 * （remain/used），没有按日的消耗明细，所以消耗统计只能靠本插件**采样求差**：
 * 每次成功拉到积分（pill 60s 轮询 + 卡片 status 轮询）记一次观测，相邻两次的
 * 负差分计消耗、正差分计发放（裂变包/续期），当日最大剩余即「今日峰值」=
 * 稳定的今日基准（今日已用 ≈ 峰值 − 当前剩余）。
 *
 * 口径（诚实声明，卡片与 README 同步）：
 * - **估算**：只有插件运行且轮询拉到积分时才有样本；两次采样之间「发放+消耗」
 *   抵消的量会被低估。样本数（samples）随数据透出，供判断可信度。
 * - **跨天首观测不计差分**：午夜前后的消耗无法归属到哪一天，宁少不虚记。
 * - 只统计积分制变体（kind 'workbuddy'）；ZCode 的 token 池与订阅有效性
 *   不是这个语义，不进台账。
 *
 * 持久化走状态域（dsh_any_connect 域的 ledger 表，per-record 布局按变体一条
 * 记录），与凭据副本同一机制；域不可用（storageDomain 服务缺席/注入前窗口）时台账整体缺席，
 * 功能静默降级为「无今日统计」，绝不影响主链路。
 *
 * @module dsh-any-connect/credit-ledger
 */

/** 台账里一天一条的聚合记录（本地日历日）。 */
export interface CreditLedgerDay {
  /** 本地日历日 YYYY-MM-DD（与用户看到的「今天」同一时区口径）。 */
  date: string
  /** 当日观测到的最大剩余——「今天的总额度基准」。 */
  peak: number
  /** 最后一次观测的剩余。 */
  last: number
  /** 当日累计消耗（负差分之和）。 */
  consumed: number
  /** 当日累计发放（正差分之和：裂变包发放、套餐续期）。 */
  granted: number
  /** 当日样本数：样本越多越可信，可排除「发放+消耗抵消」的低估窗口越大。 */
  samples: number
  updatedAtMs: number
}

/** 一份台账的持久化形态（按变体一条记录）。 */
export interface CreditLedgerState {
  days: CreditLedgerDay[]
}

/** 今日统计 + 最近 7 天历史（卡片与 pill 的透出形状）。 */
export interface CreditLedgerSummary {
  today: CreditLedgerDay
  /** 今天之前的最近 7 天，时间正序；不足 7 天就有多少。 */
  history: readonly CreditLedgerDay[]
}

/** 台账持久化的最小接口：域实现与 standalone/测试实现共用。 */
export interface CreditLedgerPersistence {
  load(variantId: string): Promise<CreditLedgerState | undefined>
  save(variantId: string, state: CreditLedgerState): Promise<void>
}

/** 台账保留的日数：近 7 天展示 + 余量，足够「控制用量」且记录恒小。 */
const MAX_DAYS = 31

/** 最近历史透出天数。 */
const HISTORY_DAYS = 7

/** 本地日历日键（插件所有「今天」的口径：用户所在时区，不是 UTC）。 */
export function dateKeyOf(now: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return (
    now.getFullYear().toString().padStart(4, '0') + '-' +
    pad(now.getMonth() + 1) + '-' +
    pad(now.getDate())
  )
}

/**
 * 把一次观测并入台账（纯函数，返回新数组）。
 *
 * 当日已有样本时差分记账：负差分计消耗、正差分计发放、峰值取最大。
 * 当日第一条样本只立基准**不计差分**——它与上一条样本之间的变化发生在
 * 跨夜窗口，归属哪一天都无法证实，宁少不虚记。
 */
export function applyObservation(days: readonly CreditLedgerDay[], total: number, now: Date): CreditLedgerDay[] {
  const key = dateKeyOf(now)
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const todayIndex = sorted.findIndex(day => day.date === key)
  if (todayIndex === -1) {
    sorted.push({
      date: key,
      peak: total,
      last: total,
      consumed: 0,
      granted: 0,
      samples: 1,
      updatedAtMs: now.getTime(),
    })
  } else {
    const today = sorted[todayIndex]!
    const delta = total - today.last
    sorted[todayIndex] = {
      ...today,
      peak: Math.max(today.peak, total),
      last: total,
      consumed: today.consumed + (delta < 0 ? -delta : 0),
      granted: today.granted + (delta > 0 ? delta : 0),
      samples: today.samples + 1,
      updatedAtMs: now.getTime(),
    }
  }
  // 只留最近 MAX_DAYS 天（含今天）：台账恒小，老数据对「控制用量」没有价值。
  return sorted.slice(-MAX_DAYS)
}

/** 由台账读今日统计 + 最近 7 天历史；今天尚无样本返回 undefined。 */
export function summarize(days: readonly CreditLedgerDay[], now: Date = new Date()): CreditLedgerSummary | undefined {
  const key = dateKeyOf(now)
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const today = sorted.find(day => day.date === key)
  if (today === undefined) return undefined
  const history = sorted.filter(day => day.date < key).slice(-HISTORY_DAYS)
  return { today, history }
}

/**
 * 按变体串行记账的台账服务。
 *
 * 所有 record 经每变体一条的 in-process promise 链排队（load→改→save），
 * 并发调用（pill 与卡片同时轮询到）不互相覆盖；record **从不 reject**——
 * 台账是统计附属品，持久化故障只降级为「没有统计」，绝不拖垮调用它的
 * status 文档或 pill 查询。
 */
export class CreditLedger {
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(private readonly persistence: CreditLedgerPersistence) {}

  /** 记一次观测；失败安静吞掉（返回 false 供诊断），绝不上抛。 */
  record(variantId: string, total: number, now: Date = new Date()): Promise<boolean> {
    const tail = this.chains.get(variantId) ?? Promise.resolve()
    const next = tail
      .then(async () => {
        const state = await this.persistence.load(variantId) ?? { days: [] }
        const days = applyObservation(state.days, total, now)
        await this.persistence.save(variantId, { days })
        return true
      })
      .catch(() => false)
    // 链上永远挂不 reject 的尾巴：后续 record 不被一次失败卡死。
    this.chains.set(variantId, next.then(() => undefined, () => undefined))
    return next
  }

  /** 读今日统计 + 近 7 天；先等该变体的写链排空，读到的一定含刚记的样本。 */
  async summary(variantId: string, now: Date = new Date()): Promise<CreditLedgerSummary | undefined> {
    const tail = this.chains.get(variantId)
    if (tail !== undefined) await tail
    const state = await this.persistence.load(variantId)
    return state === undefined ? undefined : summarize(state.days, now)
  }
}
