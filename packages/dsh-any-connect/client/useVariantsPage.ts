/**
 * useVariantsPage.ts — 变体列表页的状态与取数（渲染之外的全部逻辑）。
 *
 * 2026-10-08 从 191 行的 VariantsPage.tsx 拆出：挂载时每个变体取一次状态、慢轮询
 * 只重查未登录行、自动展开首个已登录变体、以及请求纪元的竞态守卫；页面只剩渲染。
 *
 * @module dsh-any-connect/client/useVariantsPage
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchJsonOrThrow } from './fetch-json.js'
import type { WorkBuddyWebStatus } from '../src/status-paths.js'
import { CARD_VARIANTS } from './config-types.js'
import type { WorkBuddyConfigPageInjected } from './config-types.js'
import { POLL_INTERVAL_MS } from './config-types.js'
import type { WorkBuddyCardVariant } from './config-types.js'
import type { CardStatus } from './config-types.js'

export function useVariantsPage(t: WorkBuddyConfigPageInjected['t']) {
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({})
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())
  // 自动展开只发生一次（首个确认已登录的变体），之后完全由用户控制。
  const autoExpandedRef = useRef(false)
  const mountedRef = useRef(true)
  // interval 闭包里要读到最新的表与展开集：state 之外的同步镜像。
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const openIdsRef = useRef(openIds)
  openIdsRef.current = openIds

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const fetchOne = useCallback(async (variant: WorkBuddyCardVariant, signal?: AbortSignal): Promise<WorkBuddyWebStatus> => {
    const response = await fetch(variant.statusPath, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...signal === undefined ? {} : { signal },
    })
    const value: unknown = await fetchJsonOrThrow(response)
    // 非 JSON 的 200（中间代理、204）不能进状态表：形状不对按失败处理，
    // 渲染层要读 status.status，undefined 会直接把渲染树打崩。
    if (value === null || typeof value !== 'object' || typeof (value as { status?: unknown }).status !== 'string') {
      throw new Error('unexpected status payload')
    }
    return value as WorkBuddyWebStatus
  }, [])

  const applyOne = useCallback((variantId: string, next: CardStatus): void => {
    if (mountedRef.current) setStatuses(current => ({ ...current, [variantId]: next }))
  }, [])

  // 每变体请求纪元:60s 轮询、展开刷新、refresh 后的 500ms 落定轮询并发
  // 时,慢的旧响应(如刚翻转为 signed-out 的旧 signed-in 文档)会在新响应
  // 之后落地,按 variant 键 last-write-wins 会把行短暂翻回错误状态。落地
  // 前必须确认自己仍是该变体最新一次请求。
  const fetchSeqRef = useRef<Record<string, number>>({})
  const beginFetch = useCallback((variantId: string): number => {
    const seq = (fetchSeqRef.current[variantId] ?? 0) + 1
    fetchSeqRef.current[variantId] = seq
    return seq
  }, [])
  const isCurrentFetch = useCallback((variantId: string, seq: number): boolean => fetchSeqRef.current[variantId] === seq, [])

  // 首拉与重试共用的落定链：成功进状态表，失败进 error 态（行内展示，不打扰其它变体）。
  const fetchAndApply = useCallback((variant: WorkBuddyCardVariant): void => {
    const seq = beginFetch(variant.id)
    void fetchOne(variant).then(
      status => { if (isCurrentFetch(variant.id, seq)) applyOne(variant.id, status) },
      error => { if (isCurrentFetch(variant.id, seq)) applyOne(variant.id, { status: 'error', message: error instanceof Error ? error.message : String(error) }) },
    )
  }, [fetchOne, applyOne, beginFetch, isCurrentFetch])

  // 错误行重试：先回 loading 给即时反馈，再走与首拉同一条落定链。
  const retryOne = useCallback((variant: WorkBuddyCardVariant): void => {
    applyOne(variant.id, { status: 'loading' })
    fetchAndApply(variant)
  }, [applyOne, fetchAndApply])

  // 挂载：并行拉全部变体；之后 60s 轮询只刷「未登录」与「已展开」的变体，
  // 收起的已登录卡不打扰（展开时由卡片立即拉取）。标签页隐藏时暂停轮询
  // （后台打 status 路由是纯浪费），恢复可见立即刷一次并重启——与同仓
  // session-archive / provider-usage 的轮询纪律对齐。
  useEffect(() => {
    for (const variant of CARD_VARIANTS) fetchAndApply(variant)
    const poll = () => {
      for (const variant of CARD_VARIANTS) {
        const current = statusesRef.current[variant.id]
        const needsPoll = current === undefined
          || current.status !== 'signed-in'
          || openIdsRef.current.has(variant.id)
        if (!needsPoll) continue
        const seq = beginFetch(variant.id)
        void fetchOne(variant).then(
          status => { if (isCurrentFetch(variant.id, seq)) applyOne(variant.id, status) },
          () => { /* 轮询失败不打扰：下一拍再试，已有数据保留 */ },
        )
      }
    }
    let timer = 0
    const start = () => { if (timer === 0) timer = window.setInterval(poll, POLL_INTERVAL_MS) }
    const stop = () => { if (timer !== 0) { window.clearInterval(timer); timer = 0 } }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { poll(); start() }
      else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [fetchOne, applyOne, fetchAndApply])

  // 首个已登录的变体自动展开一次。等全部变体的首拉落定再选——status 路由
  // 快慢不一（各 status 路由响应快慢不一），按"谁先回
  // 来"选会展开错误的卡片；落定后按声明顺序取第一个已登录的。
  useEffect(() => {
    if (autoExpandedRef.current) return
    const settled = CARD_VARIANTS.every(variant => {
      const current = statuses[variant.id]
      return current !== undefined && current.status !== 'loading'
    })
    if (!settled) return
    const first = CARD_VARIANTS.find(variant => statuses[variant.id]?.status === 'signed-in')
    if (first !== undefined) {
      autoExpandedRef.current = true
      setOpenIds(current => {
        const next = new Set(current)
        next.add(first.id)
        return next
      })
    }
  }, [statuses])

  const toggleOpen = useCallback((id: string): void => {
    setOpenIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    // 展开时立即刷新已登录卡:收起卡不在 60s 轮询范围,长收起后展开看到
    // 的是陈旧余额且无 loading 指示——「展开时由卡片立即拉取」的声明在此
    // 落地。loading/error 态交给既有错误行重试链,不在此重复发起。
    if (statusesRef.current[id]?.status === 'signed-in') {
      const variant = CARD_VARIANTS.find(v => v.id === id)
      if (variant !== undefined) fetchAndApply(variant)
    }
  }, [fetchAndApply])

  const anySignedIn = CARD_VARIANTS.some(variant => statuses[variant.id]?.status === 'signed-in')
  const loaded = CARD_VARIANTS.some(variant => statuses[variant.id] !== undefined)

  return {
    anySignedIn,
    applyOne,
    fetchOne,
    loaded,
    openIds,
    retryOne,
    statuses,
    toggleOpen,
  }
}
