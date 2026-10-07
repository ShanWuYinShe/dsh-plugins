/**
 * catalog-fingerprint.ts — 已发布目录的内容指纹。
 *
 * 2026-10-08 从 catalog-lifecycle.ts 拆出：纯函数（可见性 + 每行展示字段），
 * publishCatalog 用它判断「这次刷新到底改没改用户看得见的东西」。
 *
 * @module dsh-any-connect/catalog-fingerprint
 */

import type { WorkBuddyModelInfo } from './catalog.js'

/** 目录行里"会被渲染出来"的字段，按固定顺序取——顺序固定才谈得上稳定指纹。 */
const CATALOG_FINGERPRINT_BILLING_KEYS = ['credits', 'badges', 'free', 'rateUnknown'] as const

/** 一行目录参与指纹的展示字段（顺序即拼接顺序）。 */
function catalogFingerprintRow(model: WorkBuddyModelInfo): string {
  return [
    model.id,
    model.name,
    String(model.contextWindow),
    String(model.maxTokens),
    model.supportsImages === true ? '1' : '0',
    JSON.stringify(model.reasoning ?? null),
    JSON.stringify(CATALOG_FINGERPRINT_BILLING_KEYS.map(key => model.billing?.[key] ?? null)),
  ].join('\u0001')
}

/**
 * 一份**已发布目录**的内容指纹：可见性 + 每行的展示字段。
 *
 * 用于判断"这次刷新到底改没改用户看得见的东西"。取内容而非对象引用，因为
 * 每次刷新都会重建整份数组——引用比较会让每一轮定时刷新都被判成变化。
 *
 * 覆盖三件用户可见的事：某行被增删/改名/换窗口与输出上限/换图片能力/换档位
 * 集合（选择器的档位子菜单）、billing 徽标与费率（名称后缀），以及**整组是否
 * 可见**（未登录时空目录；Start Plan 今日未领取 → 空名单 → DSH 隐藏该分组）。
 * 后两者正是"名单看起来不对"最常见的两种形态，都必须通知出去。
 *
 * 刻意**不**放 `maxInputTokens` / `supportedContextWindows` / `promotions`：
 * 它们不在模型的展示名里，纳进来只会让无谓的广播变多，而"只在变化时通知"
 * 正是这条线的硬要求。
 *
 * @param models - 目录里即将发布的内容（{@link WorkBuddyCatalog.current} 的返回）。
 * @param visible - 该分组对用户是否可见。
 * @returns 稳定可比较的字符串指纹。
 */
export function catalogFingerprint(
  models: readonly WorkBuddyModelInfo[],
  visible = true,
): string {
  if (!visible) return 'hidden'
  return models.map(catalogFingerprintRow).join('\u0002')
}
