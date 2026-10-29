/**
 * variant-card-view.ts — 卡片纯派生视图：把 status / variant / probe 换算成渲染值。
 *
 * 2026-10-29 从 useVariantCard.ts 抽出（代码优雅化）：hook 应只拥有「状态与动作」，
 * 而这些「输入 → 展示文案」的换算全部是纯函数。抽开后卡片渲染只读一份派生结果，
 * 组件不再各自推导（也不再需要从这里透传中间变量）。
 *
 * 本模块无 React、无状态、无 I/O；入参即全部输入。
 *
 * @module dsh-any-connect/client/variant-card-view
 */

import type {
  WorkBuddyWebModelRow,
  WorkBuddyWebProbeSection,
} from '../src/status-paths.js'
import { formatNumber } from './config-format.js'
import { isCatalogLive, type CardStatus, type WorkBuddyCardVariant, type WorkBuddyConfigPageInjected } from './config-types.js'

/** 已登录卡片的派生输入。 */
export interface CardViewInputs {
  t: WorkBuddyConfigPageInjected['t']
  variant: WorkBuddyCardVariant
  status: Extract<CardStatus, { status: 'signed-in' }>
  probe: WorkBuddyWebProbeSection | undefined
}

/** 额度展示三态：有剩余 / 用尽 / 已过到期时刻（remain 与到期是独立事实）。 */
type PlanState = 'active' | 'exhausted' | 'expired'

/** 卡片渲染需要的全部派生值（文案已本地化）。 */
export interface CardView {
  title: string
  label: string
  isZCode: boolean
  isStartPlanCard: boolean
  isOpenCode: boolean
  zcodePlan: { remain: number; size: number; planName?: string; packageName: string; sameDay?: boolean; expiredAt?: string } | undefined
  zcodePools: readonly { label: string; remain: number; size: number }[]
  isPlanActive: boolean
  planStateLabel: string | undefined
  displayPlanName: string | undefined
  headerSummary: string
  catalogOffline: boolean
  effortsOf: (row: WorkBuddyWebModelRow) => readonly string[] | undefined
}

/** 换算一张已登录卡片的全部展示值。 */
export function deriveCardView({ t, variant, status, probe }: CardViewInputs): CardView {
  const title = t(variant.titleKey)
  // 收起态也想知道目录是否健康：目录不 live（拉取失败/回落 saved/内置列表）
  // 时在卡头摘要追加短标记——细节展开后才看得到，异常必须收着也能看见。
  // 自动重拉进行中会自愈，标记随之消失。
  const catalogOffline = !isCatalogLive(status.catalog)
  const label = status.nickname === undefined
    ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '')
    : t('signedInAs', { nickname: status.nickname })

  // 两个 ZCode 变体是完全独立的连接：coding 走普通通道扣订阅，start 走专属
  // 通道扣当日有效的专属余额——卡片呈现随变体而定，没有可切换的"模式"。
  const zcodeSide = variant.id === 'anyconnect-zcode' ? 'coding' : variant.id === 'anyconnect-zcode-sp' ? 'start' : undefined
  const isZCode = zcodeSide !== undefined
  const isStartPlanCard = zcodeSide === 'start'
  const isOpenCode = variant.id === 'anyconnect-opencode'
  const zcodePlan = isZCode && status.credits?.accounts !== undefined
    ? (status.credits.accounts.find(a => a.remain > 0) ?? status.credits.accounts[0])
    : undefined
  // Start Plan 的额度按模型分池（2026-10-24 实测 "ZCode 1024 Dev Day"：一个活动
  // 拆成多份 entitlement，每池的 capabilities 绑定各自模型，池子互不通用）。
  // 卡片必须逐池列出——只渲染"第一个有余额的池"会让其余模型的额度整个不可见，
  // 用户会以为那些模型根本没有额度。Coding Plan 的订阅额度只是有效性标志，
  // 维持单池展示。
  const zcodePools = isStartPlanCard && status.credits?.accounts !== undefined
    ? status.credits.accounts
        .filter(account => account.unit === 'tokens' && account.size > 0)
        .map(account => ({
          label: account.packageName.replace(/\s*\((?:有效|VALID|EXPIRED|已过期)\)$/i, ''),
          remain: account.remain,
          size: account.size,
        }))
    : []
  // 名称口径：Start Plan 卡报活动名（如 "ZCode Trust Build"），Coding Plan 卡
  // 报订阅名（如 "GLM Coding Pro"）。都是上游给的真实名字，谁有就用谁。
  const zcodePlanName = zcodePlan
    ? (zcodePlan.planName ?? zcodePlan.packageName).replace(/\s*\((?:有效|VALID|EXPIRED|已过期)\)$/i, '')
    : undefined
  // 展示状态三态（2026-10-11 修）：有剩余额度=有效；无剩余且仍在有效期内=已用完；
  // 无剩余且已过到期时刻=已过期。**remain 与到期是两件独立事实**——额度可能在到
  // 期前就耗尽（本机实测 SP 额度 0/300M、到期在次日 09:00），原来的
  // `remain > 0 ? 有效 : 已过期` 会把「用完了」误报成「已过期」。
  const planState: PlanState | undefined = zcodePlan === undefined
    ? undefined
    : zcodePlan.remain > 0
      ? 'active'
      : zcodePlan.expiredAt !== undefined && Date.parse(zcodePlan.expiredAt) <= Date.now()
        ? 'expired'
        : 'exhausted'
  const isPlanActive = planState === 'active'
  const planStateLabel = planState === undefined
    ? undefined
    : t(planState === 'active' ? 'codingPlanActive' : planState === 'expired' ? 'codingPlanExpired' : 'planQuotaExhausted')
  const displayPlanName = isStartPlanCard ? (zcodePlanName ?? t('startPlanLabel')) : zcodePlanName

  // 卡头摘要：已登录身份 + 当前积分/套餐状态，收起态下也要一眼看到。
  const headerSummary = [
    isZCode
      ? [
          label,
          displayPlanName !== undefined
            ? `${displayPlanName} · ${planStateLabel ?? t('codingPlanActive')}`
            : (status.credits !== undefined ? t('codingPlanActive') : undefined),
        ].filter(part => part !== undefined).join(' · ')
      : isOpenCode
        ? [label, t('openCodeFreeBadge')].filter(part => part !== undefined).join(' · ')
        : [
            label,
            status.credits !== undefined ? t('creditsTotal', { total: formatNumber(status.credits.total) }) : undefined,
            // 裂变包每天发新包/旧包到期，「当前积分」每天双向跳动；卡头带上
            // 「今日已用」，收起态也能一眼读出今天的消耗（台账有样本才显示）。
            status.credits?.today !== undefined
              ? t('creditsTodayShort', { used: formatNumber(status.credits.today.consumed) })
              : undefined,
          ].filter(part => part !== undefined).join(' · '),
    ...(catalogOffline ? [t('catalogOfflineShort')] : []),
  ].filter(part => part !== '').join(' · ')

  /** Efforts shown on one model row: a declared set wins, then a validating
   * observation (mirrors the adapter's own precedence). Models whose probe
   * concluded "upstream ignores the parameter" simply show no levels. */
  const effortsOf = (row: WorkBuddyWebModelRow): readonly string[] | undefined => {
    if (row.efforts !== undefined && row.efforts.length > 0) return row.efforts
    const result = probe?.results.find(entry => entry.id === row.id)
    return result !== undefined && result.validation === 'validating' ? result.efforts : undefined
  }

  return {
    title,
    label,
    isZCode,
    isStartPlanCard,
    isOpenCode,
    zcodePlan,
    zcodePools,
    isPlanActive,
    planStateLabel,
    displayPlanName,
    headerSummary,
    catalogOffline,
    effortsOf,
  }
}
