/**
 * upstream-zcode-normalize.ts — ZCode 上游响应的纯归一化：目录合流与订阅额度。
 *
 * 2026-10-08 从 395 行的 upstream-zcode.ts 拆出：这两段是「拿到 JSON 之后怎么算」，
 * 与网络/超时/降级无关，抽出来后可以脱离 HTTP 单独喂样本测试（此前只有整链路测试）。
 *
 * @module dsh-any-connect/upstream-zcode-normalize
 */

import type { WorkBuddyCreditAccount, WorkBuddyCredits, WorkBuddyUpstreamModel } from './upstream.js'
import { defaultZCodeModelInfo } from './upstream-zcode-body.js'

/** 订阅接口不可用时的兜底额度（HTTP 非 ok 与抛错两处共用，避免字面量漂移）。 */
export const CODING_PLAN_FALLBACK_CREDITS: WorkBuddyCredits = {
  total: 1,
  accounts: [{ packageName: 'Coding Plan (有效)', remain: 1, size: 1 }],
}

/**
 * 三方合流：上游 paas 目录 ∩ 客户端产品面白名单，本地收录过的沿用整行。
 *
 * 白名单是总闸——官方未收录的 id 不展示（那不是本订阅的名单）；白名单内本地收录过的
 * 沿用整行（128K / 费率 / 徽章都不丢），没收录过的走保守默认（新模型能出现，但不虚报
 * 窗口与费率）；本地收录、上游没列的，仍在白名单内才保留。
 */
export function mergeZCodeCatalogue(
  models: readonly WorkBuddyUpstreamModel[],
  upstreamIds: readonly string[],
  whitelist: ReadonlySet<string>,
): WorkBuddyUpstreamModel[] {
  const known = new Map(models.map(model => [model.id.toLowerCase(), model]))
  const merged: WorkBuddyUpstreamModel[] = []
  const seen = new Set<string>()
  for (const rawId of upstreamIds) {
    const key = rawId.toLowerCase()
    if (seen.has(key)) continue
    if (!whitelist.has(key)) continue
    seen.add(key)
    const hit = known.get(key)
    merged.push(hit ?? defaultZCodeModelInfo(rawId))
  }
  for (const model of models) {
    const key = model.id.toLowerCase()
    if (seen.has(key)) continue
    if (!whitelist.has(key)) continue
    seen.add(key)
    merged.push(model)
  }
  return merged
}

/**
 * 订阅列表响应 → 额度账户。
 *
 * 计划名单独留一份：上游的产品名就是用户看到的活动/套餐名（例如 "ZCode Trust Build"），
 * 界面上的 plan 标签必须用它，而不是写死 "Coding Plan"——那会把用户实际没有的套餐名
 * 报给用户。无效状态如实标注，有效期只在能解析时带上。
 */
export function codingPlanCreditsFrom(json: { data?: Array<Record<string, any>> }): WorkBuddyCredits {
  const accounts: WorkBuddyCreditAccount[] = []
  if (Array.isArray(json.data) && json.data.length > 0) {
    for (const item of json.data) {
      const name = item.productName || 'Coding Plan'
      const isValid = item.status === 'VALID' || item.status === 'ACTIVE'
      let expiredAt: string | undefined
      if (item.expireTime) {
        const d = new Date(item.expireTime)
        if (!Number.isNaN(d.getTime())) expiredAt = d.toISOString()
      }
      accounts.push({
        packageName: isValid ? name + ' (有效)' : name + ' (' + (item.status ?? '未知') + ')',
        planName: name,
        remain: isValid ? 1 : 0,
        size: 1,
        ...expiredAt === undefined ? {} : { expiredAt },
      })
    }
  } else {
    accounts.push({
      packageName: 'Coding Plan (有效)',
      remain: 1,
      size: 1,
    })
  }
  return {
    total: accounts.reduce((acc, cur) => acc + cur.remain, 0),
    accounts,
  }
}
