/**
 * useVariantCard.ts — 变体卡片的状态与动作（渲染之外的全部逻辑）。
 *
 * 2026-10-08 从 422 行的 VariantCard.tsx 拆出：探测、刷新、目录等待、领取复制、
 * 展开/折叠等；组件只剩渲染。
 *
 * 2026-10-29 优雅化：纯派生视图（身份/套餐/卡头摘要/档位）移到
 * variant-card-view.ts，动作壳（busy/notice/重读 status）合并为一个
 * runCardAction；本模块只保留状态机与副作用。
 *
 * @module dsh-any-connect/client/useVariantCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchJsonOrThrow } from './fetch-json.js'
import type {
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
import { deriveCardView } from './variant-card-view.js'

/** 探测动作：刷新或模型排除/恢复操作。 */
type ProbeAction =
  | { action: 'refresh' }
  | { action: 'delete-model'; modelId: string }
  | { action: 'restore-model'; modelId: string }
  | { action: 'restore-models' }

/** useVariantCard 的完整返回值：状态/动作 + 纯派生视图（{@link deriveCardView}）。 */
export type VariantCardView = ReturnType<typeof useVariantCard>

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
  // 刷新失败提示 8s 自动消退：一次瞬时网络抖动的红字不该挂到下次手动刷新，
  // 也不该让用户找关闭按钮——下一轮刷新会重新给反馈。
  useEffect(() => {
    if (notice === undefined) return
    const timer = window.setTimeout(() => { if (mounted.current) setNotice(undefined) }, 8000)
    return () => window.clearTimeout(timer)
  }, [notice])
  // 模型清单默认收起：它是最长的一段，而卡片的常看信息只有积分本身。
  const [modelsOpen, setModelsOpen] = useState(false)
  // 隐藏区默认收起：它是「找回来」的入口，不是日常查看的对象，展开会挤占
  // 可见模型列表。有隐藏项时标题行始终显示数量，用户知道它存在。
  const [excludedOpen, setExcludedOpen] = useState(false)
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
  /** 当前上游限流（429 观测）；缺席即「现在没被限」。 */
  const rateLimit = status.rateLimit
  /**
   * 已隐藏模型的完整行。
   *
   * 只拿 excludedCount 时用户唯一能做的就是「一键全部恢复」——多数情况他只想
   * 放回其中一两个，全恢复后还得把其余重新隐藏一遍。完整行让隐藏区能逐条渲染
   * 恢复按钮。
   */
  const excludedModels = status.excludedModels ?? []

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

  /** 卡片控制端点（探针刷新 / 模型排除 / 恢复）；非 2xx 由 fetchJsonOrThrow 抛。 */
  const control = useCallback(async (action: ProbeAction): Promise<void> => {
    if (probeKey === undefined) throw new Error(t('requestFailed'))
    const response = await fetch(variant.probePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workbuddy-probe-key': probeKey },
      credentials: 'same-origin',
      body: JSON.stringify(action),
    })
    await fetchJsonOrThrow(response)
  }, [probeKey, t, variant.probePath])

  /** 等目录落地：每次重读 status，live 即停、超时即停。首读立即发生，
   * 替代固定盲等（目录快时白等、慢时读到旧目录又触发二次刷新）。 */
  const waitCatalogLive = useCallback(async (previousFetchedAt?: number): Promise<void> => {
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
      const catalog = next.status === 'signed-in' ? next.catalog : undefined
      const fetchedAt = catalog?.fetchedAt
      const hasUpdated = previousFetchedAt !== undefined
        ? (fetchedAt !== undefined && fetchedAt > previousFetchedAt)
        : isCatalogLive(catalog)
      if ((isCatalogLive(catalog) && hasUpdated) || Date.now() - startedAt >= REFRESH_TIMEOUT_MS) return
      await new Promise(resolve => setTimeout(resolve, REFRESH_POLL_MS))
    }
  }, [fetchStatus, applyStatus])

  /**
   * 卡片动作的统一壳：置 busy / 清旧提示 → 执行控制请求（刷新动作额外等目录
   * 落地）→ 无论成败都重读一次 status → 清 busy。异常只落 inline notice：
   * 屏幕上已有数据时，瞬时失败不该把卡片打空。
   */
  const runCardAction = useCallback(async (
    action: ProbeAction,
    waitCatalog: ((previousFetchedAt?: number) => Promise<void>) | undefined,
  ): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    // 刷新动作以当前目录的 fetchedAt 为基线，等一个更新的目录落地。
    const previousFetchedAt = waitCatalog === undefined ? undefined : status.catalog?.fetchedAt
    try {
      await control(action)
      await waitCatalog?.(previousFetchedAt)
    } catch (error: unknown) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : t('requestFailed'))
    } finally {
      await refresh()
      if (mounted.current) setBusy(false)
    }
  }, [control, refresh, status.catalog?.fetchedAt, t])

  /** The merged refresh button: ask the host to re-pull the catalog first
   * (returns immediately), then poll the status document until the fresh
   * catalog lands or the wait times out. */
  const refreshWithCatalog = useCallback(
    (): Promise<void> => runCardAction({ action: 'refresh' }, waitCatalogLive),
    [runCardAction, waitCatalogLive],
  )

  const deleteModel = useCallback(
    (modelId: string): Promise<void> => runCardAction({ action: 'delete-model', modelId }, undefined),
    [runCardAction],
  )

  /** 恢复单个隐藏模型（用户主路径：只放回想要的那几个）。 */
  const restoreModel = useCallback(
    (modelId: string): Promise<void> => runCardAction({ action: 'restore-model', modelId }, undefined),
    [runCardAction],
  )

  const restoreModels = useCallback(
    (): Promise<void> => runCardAction({ action: 'restore-models' }, undefined),
    [runCardAction],
  )

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

  // 纯派生（身份/套餐/卡头摘要/档位）：输入即全部输入，见 variant-card-view.ts。
  const view = deriveCardView({ t, variant, status, probe })

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
    excludedOpen,
    setExcludedOpen,
    copiedPlanId,
    probe,
    startPlanClaim,
    rateLimit,
    copyPlanId,
    refresh,
    refreshWithCatalog,
    deleteModel,
    restoreModel,
    restoreModels,
    /** 已隐藏模型的完整行（卡片隐藏区逐条渲染）。 */
    excludedModels,
    /** 纯派生视图（渲染只读它，见 variant-card-view.ts）。 */
    view,
  }
}
