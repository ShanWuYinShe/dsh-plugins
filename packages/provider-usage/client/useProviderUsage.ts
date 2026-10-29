/**
 * useProviderUsage.ts — 状态与取数（订阅目录 + 60s 轮询 + 交互状态）
 *
 * 2026-10-08 从 474 行的 ProviderUsagePill.tsx 拆出。
 *
 * @module provider-usage/状态与取数（订阅目录 + 60s 轮询 + 交互状态）
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { UsageSnapshot } from '../src/types.js'
import { fetchSnapshot } from './fetch-snapshot.js'
import { RESOURCE_POLL_INTERVAL_MS, usageResourceAddress } from './resource-provider.js'
import { isStaleDisplay } from './pill-format.js'
import { exhaustedResetText, headlineText } from './pill-headline.js'
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

export function useProviderUsage({ t, directory: injectedDirectory, load: injectedLoad, useResource, resolveSeat, sessionId }: ProviderUsagePillProps) {
  if (t === undefined) throw new Error('provider-usage: the pill requires its translation function')
  // 目录在**渲染期**解析，不在注册期（宿主自带 pill 同样如此：它们的 inject 是
  // 无参常量，会话数据走 standard kit）。resolveSeat 从不抛错，拿不到就返回
  // undefined，这一次渲染不显示，下一帧自动重试——不存在「坏 props 被永久缓存」
  // 或「render 抛错被宿主 abdicate」这两条失效路径。
  //
  // useMemo 按 sessionId 缓存：同一会话的重渲染不该反复问服务，切换会话才重解析。
  const seat = useMemo(
    () => resolveSeat?.(sessionId),
    [resolveSeat, sessionId],
  )
  // 兼容旧注入面：调用方（测试/独立部署）也可以直接给 directory/load。
  const directory = injectedDirectory ?? seat?.directory
  const load = injectedLoad ?? seat?.load
  // Subscribe to the same per-session directory the composer's model seat
  // renders from, so a model switch moves the pill with no coordination and a
  // brand-new session (empty durable projection) still reports.
  const state = useSyncExternalStore(
    // 方法引用不绑定 this：宿主目录实现若依赖 this 会静默坏，包一层箭头防御。
    directory === undefined ? (() => () => {}) : (fn => directory.subscribe(fn)),
    directory === undefined ? (() => ABSENT_DIRECTORY) : (() => directory.getSnapshot()),
  )
  // The directory is lazy: `current` stays null until someone loads it.
  // 此外，会话长期搁置或宿主重连（connection/reset）时目录可能被重置为 null；
  // 此时若只在 mount 调一次 load，pill 会因为 provider 为空而永久消失。
  // 因此只要 current 为 null 且目录不在 loading 或 error 中，就主动触发 load()。
  useEffect(() => {
    if (state.current === null && state.status !== 'loading' && state.status !== 'error') {
      load?.()
    }
  }, [state.current, state.status, load])


  const currentProvider = state.current?.provider
  const lastProviderRef = useRef<string | undefined>(undefined)
  if (currentProvider !== undefined && currentProvider !== '') {
    lastProviderRef.current = currentProvider
  }
  // 保持旧 provider 避免宿主重连或目录重载瞬间 pill 整块 DOM 卸载消失
  const provider = currentProvider ?? lastProviderRef.current

  // resource 订阅面:renderer 注入 useResource(GUI 装配 resources)时启用,
  // 轮询/唤醒逻辑整体让位给 resource-provider 的统一流;缺席(独立 dsh-web
  // 部署)时为 undefined,下方全部既有轮询逻辑原样生效。
  // useResource 是 hook,必须无条件调用——provider 未解析时用空地址占位
  // (该地址产空流),反正此形态下组件在函数尾部 return null 不渲染。
  const resource = useResource?.(usageResourceAddress(provider ?? ''))
  const liveAnswer = resource?.status === 'live' ? resource.value : undefined
  // 手动强刷的抑制窗:force 结果写回本地 answer 并压住流里的旧帧,直到
  // 流下一帧(≤60s+余量)带着宿主强刷后的新缓存值接管,强值永不倒退。
  const manualUntilRef = useRef(0)

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

  // 面板打开期间窗口尺寸变化（resize、侧栏收展）也要重判翻转：对齐只在
  // 打开瞬间决定的话，打开后收窄视口会让 320px 面板溢出屏幕右缘。
  useEffect(() => {
    if (!open) return
    const realign = () => {
      if (!buttonRef.current) return
      setAlignRight(buttonRef.current.getBoundingClientRect().left + 320 > window.innerWidth - 8)
    }
    window.addEventListener('resize', realign)
    return () => window.removeEventListener('resize', realign)
  }, [open])

  // 跨闭包跟踪当前 provider:手动刷新(面板内按钮)不带 AbortSignal,provider
  // 切换时无法取消在途的旧请求——写回前必须核对响应的 provider 是否仍是
  // 当前值,否则 A 的旧余额会顶着 B 的名字显示到下一轮轮询。
  const providerRef = useRef(provider)
  useEffect(() => { providerRef.current = provider }, [provider])

  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])

  const stateCurrentRef = useRef(state.current)
  useEffect(() => { stateCurrentRef.current = state.current }, [state.current])

  const refresh = useCallback(async (signal?: AbortSignal, options?: { force?: boolean }): Promise<void> => {
    if (provider === undefined || provider === '') return
    if (stateCurrentRef.current === null) {
      loadRef.current?.()
    }
    setBusy(true)
    try {
      const snapshot = await fetchSnapshot(provider, signal, options)
      if (mounted.current && signal?.aborted !== true && providerRef.current === provider) {
        answerRef.current = snapshot
        setAnswer(snapshot)
        setStale(false)
        // 强刷更新宿主 registry 缓存(resource 模式)——流下一帧带新值;在
        // 那之前由抑制窗压住流里的旧帧,强值不倒退。仅 force 生效:自动
        // 轮询(缓存读)不设窗,流帧与轮询答案本就同源同值。
        if (options?.force === true) manualUntilRef.current = Date.now() + RESOURCE_POLL_INTERVAL_MS + 5_000
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

  // Provider 切换或初次挂载时发起拉取；若只是网络抖动导致 current 短暂置空、但
  // 最终恢复为同一 provider，则不清空旧答案与过期标记，避免不必要的数字闪烁与白屏。
  const activeProviderRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (provider === undefined || provider === '') return
    if (activeProviderRef.current !== provider) {
      activeProviderRef.current = provider
      answerRef.current = undefined
      setAnswer(undefined)
      setStale(false)
      // 切 provider 换地址,流自动重开;抑制窗一并作废。
      manualUntilRef.current = 0
    }
    // resource 模式:首帧由流的 open 立即给出,这里不再手动拉。
    if (useResource !== undefined) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => { controller.abort() }
  }, [provider, refresh, useResource])

  // 目录重连恢复：从 current === null 恢复到有值时，立即重拉一次额度
  const prevCurrentRef = useRef(state.current)
  useEffect(() => {
    const wasNull = prevCurrentRef.current === null
    prevCurrentRef.current = state.current
    if (wasNull && state.current !== null && provider !== undefined && provider !== '') {
      if (useResource === undefined) void refresh()
    }
  }, [state.current, provider, refresh, useResource])

  // 60s 轮询 + 唤醒恢复（可见性 / focus / online）
  // 无论当前 provider 是否已经解析出，都要维持轮询与唤醒监听：
  // 1. 若 current 为 null（如夜间长期搁置导致会话断开），轮询与唤醒负责重试 load()；
  // 2. 若 provider 正常，负责刷新用量快照。
  useEffect(() => {
    // resource 模式:轮询/唤醒由 resource-provider 的统一流承担,这里退出。
    if (useResource !== undefined) return
    const controller = new AbortController()
    let timer: number | undefined
    const trigger = () => {
      if (state.current === null) {
        load?.()
      } else if (provider !== undefined && provider !== '') {
        void refresh(controller.signal)
      }
    }
    const start = () => {
      timer = window.setInterval(trigger, POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    let lastWake = 0
    const onWake = () => {
      if (document.visibilityState === 'visible') {
        stop()
        const now = Date.now()
        // 1 秒内防抖，避免 visibilitychange / focus / online 连发造成并发重刷
        if (now - lastWake > 1000) {
          lastWake = now
          trigger()
        }
        start()
      } else {
        stop()
      }
    }

    if (document.visibilityState === 'visible') {
      start()
    }
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    window.addEventListener('online', onWake)

    return () => {
      stop()
      controller.abort()
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      window.removeEventListener('online', onWake)
    }
  }, [state.current, provider, load, refresh, useResource])

  if (provider === undefined || provider === '') return null

  // 合成答案:resource 模式优先流值,抑制窗内手动强刷值优先;回退模式
  // liveAnswer 恒 undefined,effective 即轮询答案,行为与改造前一致。
  const effectiveAnswer = Date.now() < manualUntilRef.current ? answer : (liveAnswer ?? answer)
  const queried = effectiveAnswer !== undefined && !('queried' in effectiveAnswer)
  const snapshot = queried ? effectiveAnswer as UsageSnapshot : undefined
  const isDisconnected = state.current === null && lastProviderRef.current !== undefined
  // 宿主折叠旧答案（degraded）、客户端请求失败、或目录重连中（current 为 null）均视为「数据可能过期」。
  const displayStale = isStaleDisplay(stale || isDisconnected, snapshot)
  const headline = headlineText(effectiveAnswer, provider, displayStale, t)
  // 额度用尽时补「几点恢复」：这是用户「到什么时候能接着用」的直接答案。
  // 只在真用尽（remain === 0 且有 resetsAt）时出现，有余额时不打扰。
  const resetHint = snapshot === undefined ? undefined : exhaustedResetText(snapshot, t)


  return {
    t,
    provider,
    answer: effectiveAnswer,
    open,
    setOpen,
    busy,
    stale: displayStale,
    alignRight,
    setAlignRight,
    rootRef,
    buttonRef,
    panelRef,
    refresh,
    queried,
    snapshot,
    headlineText: headline,
    resetHint,
  }
}
