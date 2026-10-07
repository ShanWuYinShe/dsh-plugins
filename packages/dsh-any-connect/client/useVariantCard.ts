/**
 * useVariantCard.ts — 变体卡片的状态与动作（渲染之外的全部逻辑）。
 *
 * 2026-10-08 从 422 行的 VariantCard.tsx 拆出：探测、刷新、目录等待、领取复制、
 * 展开/折叠等；组件只剩渲染。
 *
 * @module dsh-any-connect/client/useVariantCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  WorkBuddyWebCatalog,
  WorkBuddyWebModelRow,
  WorkBuddyWebProbeSection,
  WorkBuddyWebStartPlanClaim,
  WorkBuddyWebStatus,
} from '../src/status-paths.js'
import {
  REFRESH_POLL_MS,
  REFRESH_TIMEOUT_MS,
  isCatalogLive,
  type WorkBuddyConfigPageInjected,
  type WorkBuddyCardVariant,
  type CardStatus,
} from './config-types.js'
import { formatNumber } from './config-format.js'

/** 探测动作：目前只有「重拉一次」。 */
type ProbeAction = { action: 'refresh' }

export function useVariantCard({ t, variant, status, open, onToggle, fetchStatus, applyStatus }: {
  t: WorkBuddyConfigPageInjected['t']
  variant: WorkBuddyCardVariant
  status: Extract<CardStatus, { status: 'signed-in' }>
  open: boolean
  onToggle: () => void
  /** Re-read this variant's status document (caller owns state updates). */
  fetchStatus: (signal?: AbortSignal) => Promise<WorkBuddyWebStatus>
  applyStatus: (next: CardStatus) => void
}) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  // 模型清单默认收起：它是最长的一段，而卡片的常看信息只有积分本身。
  const [modelsOpen, setModelsOpen] = useState(false)
  // 「已复制」是短暂反馈：复制成功给一次确认，2s 后自行复原，不留陈旧状态。
  const [copiedPlanId, setCopiedPlanId] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const probe: WorkBuddyWebProbeSection | undefined = status.probe
  const probeKey = status.probeKey
  /** 今日 Start Plan 待领取探测结果；只有 Start Plan 变体的 status 会带。 */
  const startPlanClaim: WorkBuddyWebStartPlanClaim | undefined = status.startPlanClaim

  /**
   * 把 plan_id 复制到剪贴板（用户要拿着它去客户端核对领取的活动）。
   *
   * 剪贴板在非安全上下文/无权限时会 reject，所以失败只当作"没复制"静默处理：
   * 这个按钮是便利功能，不该因为浏览器权限弹错误打断卡片。
   */
  const copyPlanId = useCallback(async (planId: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(planId)
      if (!mounted.current) return
      setCopiedPlanId(true)
      window.setTimeout(() => { if (mounted.current) setCopiedPlanId(false) }, 2000)
    } catch {
      // 复制失败不改状态：plan_id 本身已经显示在卡片上，用户仍可手动选中复制。
    }
  }, [])

  /** Re-read the status document; failures degrade to an inline notice — with
   * data already on screen a transient failure must not blank the card. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchStatus()
      if (mounted.current) applyStatus(next)
    } catch (error: unknown) {
      if (mounted.current) {
        setNotice(error instanceof Error ? error.message : t('requestFailed'))
      }
    }
  }, [applyStatus, fetchStatus, t])

  const control = useCallback(async (action: ProbeAction): Promise<void> => {
    if (probeKey === undefined) throw new Error(t('requestFailed'))
    const response = await fetch(variant.probePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-probe-key': probeKey },
      credentials: 'same-origin',
      body: JSON.stringify(action),
    })
    const value: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const detail = typeof (value as { error?: unknown } | null)?.error === 'string'
        ? `: ${(value as { error: string }).error}`
        : ''
      throw new Error(`HTTP ${response.status}${detail}`)
    }
  }, [probeKey, t, variant.probePath])

  /** 等目录落地：每次重读 status，live 即停、超时即停。首读立即发生，
   * 替代固定盲等（目录快时白等、慢时读到旧目录又触发二次刷新）。 */
  const waitCatalogLive = useCallback(async (): Promise<void> => {
    const startedAt = Date.now()
    for (;;) {
      let next: WorkBuddyWebStatus
      try {
        next = await fetchStatus()
      } catch {
        return
      }
      if (!mounted.current) return
      applyStatus(next)
      // signed-out 文档无 catalog 字段：按缺失处理（继续轮询至超时）。
      const catalog = (next as { catalog?: WorkBuddyWebCatalog }).catalog
      if (isCatalogLive(catalog) || Date.now() - startedAt >= REFRESH_TIMEOUT_MS) return
      await new Promise(resolve => setTimeout(resolve, REFRESH_POLL_MS))
    }
  }, [fetchStatus, applyStatus])

  /** The merged refresh button: ask the host to re-pull the catalog first
   * (returns immediately), then poll the status document until the fresh
   * catalog lands or the wait times out. */
  const refreshWithCatalog = useCallback(async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      await control({ action: 'refresh' })
      await waitCatalogLive()
    } catch (error: unknown) {
      // refresh POST 失败也照常读一次 status：读本身可能仍是成功的。
      if (mounted.current) setNotice(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      await refresh()
      if (mounted.current) setBusy(false)
    }
  }, [control, refresh, t, waitCatalogLive])

  // Stale 目录自动刷新一次：saved/fallback 或上次失败时，后台重拉目录，
  // 用户不用按刷新。once per mount；失败只进 notice，不打扰不循环。
  const autoRefreshTried = useRef(false)
  useEffect(() => {
    if (autoRefreshTried.current) return
    if (probeKey === undefined) return
    const catalog = status.catalog
    if (catalog === undefined) return
    if (isCatalogLive(catalog)) return
    autoRefreshTried.current = true
    void refreshWithCatalog()
  }, [probeKey, status.catalog, refreshWithCatalog])

  const title = t(variant.titleKey)
  const label = status.nickname === undefined
    ? t('signedInAs', { nickname: '' }).replace(/[:：]\s*$/, '')
    : t('signedInAs', { nickname: status.nickname })

  // 两个 ZCode 变体是完全独立的连接：coding 走普通通道扣订阅，start 走专属
  // 通道扣当日有效的专属余额——卡片呈现随变体而定，没有可切换的"模式"。
  const zcodeSide = variant.id === 'anyconnect-zcode' ? 'coding' : variant.id === 'anyconnect-zcode-sp' ? 'start' : undefined
  const isZCode = zcodeSide !== undefined
  const isStartPlanCard = zcodeSide === 'start'
  const zcodePlan = isZCode && status.credits?.accounts !== undefined
    ? (status.credits.accounts.find(a => a.remain > 0) ?? status.credits.accounts[0])
    : undefined
  // 名称口径：Start Plan 卡报活动名（如 "ZCode Trust Build"），Coding Plan 卡
  // 报订阅名（如 "GLM Coding Pro"）。都是上游给的真实名字，谁有就用谁。
  const zcodePlanName = zcodePlan
    ? (zcodePlan.planName ?? zcodePlan.packageName).replace(/\s*\((?:有效|VALID|EXPIRED|已过期)\)$/i, '')
    : undefined
  const isPlanActive = zcodePlan !== undefined && zcodePlan.remain > 0
  const displayPlanName = isStartPlanCard ? (zcodePlanName ?? t('startPlanLabel')) : zcodePlanName

  // 卡头摘要：已登录身份 + 当前积分/套餐状态，收起态下也要一眼看到。
  const headerSummary = isZCode
    ? [
        label,
        displayPlanName !== undefined
          ? `${displayPlanName} · ${t(isPlanActive ? 'codingPlanActive' : 'codingPlanExpired')}`
          : (status.credits !== undefined ? t('codingPlanActive') : undefined),
      ].filter(part => part !== undefined).join(' · ')
    : [
        label,
        status.credits !== undefined ? t('creditsTotal', { total: formatNumber(status.credits.total) }) : undefined,
      ].filter(part => part !== undefined).join(' · ')

  /** Efforts shown on one model row: a declared set wins, then a validating
   * observation (mirrors the adapter's own precedence). Models whose probe
   * concluded "upstream ignores the parameter" simply show no levels. */
  const effortsOf = (row: WorkBuddyWebModelRow): readonly string[] | undefined => {
    if (row.efforts !== undefined && row.efforts.length > 0) return row.efforts
    const result = probe?.results.find(entry => entry.id === row.id)
    return result !== undefined && result.validation === 'validating' ? result.efforts : undefined
  }


  return {
    variant,
    status,
    open,
    onToggle,
    t,
    busy,
    notice,
    modelsOpen,
    setModelsOpen,
    copiedPlanId,
    probe,
    startPlanClaim,
    copyPlanId,
    refresh,
    refreshWithCatalog,
    title,
    label,
    isZCode,
    isStartPlanCard,
    zcodePlan,
    isPlanActive,
    displayPlanName,
    headerSummary,
    effortsOf,
  }
}
