/**
 * useProviderUsage.ts — 状态与取数（订阅目录 + 60s 轮询 + 交互状态）
 *
 * 2026-10-08 从 474 行的 ProviderUsagePill.tsx 拆出。
 *
 * @module provider-usage/状态与取数（订阅目录 + 60s 轮询 + 交互状态）
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { UsageSnapshot } from '../src/types.js'
import { fetchSnapshot } from './fetch-snapshot.js'
import { headlineText } from './pill-headline.js'
import type { ProviderUsagePillProps } from './pill-types.js'

/** Poll cadence while a session is open; the host caches on the same order. */
const POLL_INTERVAL_MS = 60_000

/** One provider answer as the route serializes it: a snapshot, or a not-queried marker. */
type RouteAnswer = UsageSnapshot | { provider: string; queried: false }

/** The stored default snapshot used before the directory has loaded. */
const ABSENT_DIRECTORY: ModelDirectoryState = {
  current: null,
  pending: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

export function useProviderUsage({ t, directory, load }: ProviderUsagePillProps) {
  if (t === undefined) throw new Error('provider-usage: the pill requires its translation function')
  // Subscribe to the same per-session directory the composer's model seat
  // renders from, so a model switch moves the pill with no coordination and a
  // brand-new session (empty durable projection) still reports.
  const state = useSyncExternalStore(
    // 方法引用不绑定 this：宿主目录实现若依赖 this 会静默坏，包一层箭头防御。
    directory === undefined ? (() => () => {}) : (fn => directory.subscribe(fn)),
    directory === undefined ? (() => ABSENT_DIRECTORY) : (() => directory.getSnapshot()),
  )
  // The directory is lazy: `current` stays null until someone loads it, which
  // the composer's own model seat does on mount. A pill that only read the
  // snapshot would sit blank forever on a fresh session.
  useEffect(() => { load?.() }, [load])
  const provider = state.current?.provider
  const [answer, setAnswer] = useState<RouteAnswer | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 保旧值时的“数据可能过期”信号：只有展示更早成功答案时才亮。
  const [stale, setStale] = useState(false)
  // 面板左右对齐：触发按钮靠右缘时左对齐面板会溢出视口，提前翻转。
  const [alignRight, setAlignRight] = useState(false)
  const answerRef = useRef<RouteAnswer | undefined>(undefined)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Click-outside and Escape key dismissal
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // 面板挂着 role="dialog" 就必须可聚焦、可进入：打开时把焦点移入面板
  // （键盘用户才能读到 380px 可滚内容），关闭时归还给触发按钮。
  useEffect(() => {
    if (open && !prevOpenRef.current) panelRef.current?.focus()
    else if (!open && prevOpenRef.current) buttonRef.current?.focus()
    prevOpenRef.current = open
  }, [open])

  // 跨闭包跟踪当前 provider:手动刷新(面板内按钮)不带 AbortSignal,provider
  // 切换时无法取消在途的旧请求——写回前必须核对响应的 provider 是否仍是
  // 当前值,否则 A 的旧余额会顶着 B 的名字显示到下一轮轮询。
  const providerRef = useRef(provider)
  useEffect(() => { providerRef.current = provider }, [provider])
  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (provider === undefined || provider === '') return
    setBusy(true)
    try {
      const snapshot = await fetchSnapshot(provider, signal)
      if (mounted.current && signal?.aborted !== true && providerRef.current === provider) {
        answerRef.current = snapshot
        setAnswer(snapshot)
        setStale(false)
      }
    } catch (error: unknown) {
      // Keep the last good answer: a transient failure must not blank the
      // number the user is reading. Showing an older success is flagged
      // stale (dot dims + copy suffix); anything else degrades to failed.
      const prev = answerRef.current
      if (prev !== undefined && !('queried' in prev) && prev.error === undefined) {
        if (mounted.current && signal?.aborted !== true && providerRef.current === provider) setStale(true)
        return
      }
      if (mounted.current && signal?.aborted !== true && providerRef.current === provider) {
        const failed: RouteAnswer = { provider, windows: [], fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
        answerRef.current = failed
        setAnswer(failed)
      }
    } finally {
      // 手动刷新与轮询并发时,迟到的旧请求不得提前关掉新请求的 busy。
      if (mounted.current && providerRef.current === provider) setBusy(false)
    }
  }, [provider])

  useEffect(() => {
    if (provider === undefined || provider === '') return
    const controller = new AbortController()
    // Reset first so a provider switch never shows the previous provider's
    // balance while the new answer is in flight.
    answerRef.current = undefined
    setAnswer(undefined)
    setStale(false)
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [provider, refresh])

  useEffect(() => {
    if (provider === undefined || provider === '') return
    const controller = new AbortController()
    let timer: number | undefined
    const start = () => { timer = window.setInterval(() => { void refresh(controller.signal) }, POLL_INTERVAL_MS) }
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined } }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { void refresh(controller.signal); start() }
      else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      controller.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [provider, refresh])

  if (provider === undefined || provider === '') return null

  const queried = answer !== undefined && !('queried' in answer)
  const snapshot = queried ? answer as UsageSnapshot : undefined
  const headline = headlineText(answer, provider, stale, t)


  return {
    t,
    provider,
    answer,
    open,
    setOpen,
    busy,
    stale,
    alignRight,
    setAlignRight,
    rootRef,
    buttonRef,
    panelRef,
    refresh,
    queried,
    snapshot,
    headlineText: headline,
  }
}
