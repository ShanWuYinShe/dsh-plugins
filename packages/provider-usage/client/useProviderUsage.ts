/**
 * useProviderUsage.ts — 状态与取数（目录 seat + resource live 流 + 交互状态）
 *
 * 额度数据只有一条通道：本包在 apply 里为协议 'provider-usage' 注册的
 * ResourceProvider，经宿主 standard kit 的 `useResource(address)` 订阅 live
 * 流（首帧立即、之后每 60s 由 provider 侧取一次、有变化才推帧）。组件内
 * 不再有轮询定时器、唤醒监听或第二条取数路径；provider 切换即换地址、
 * 流自动重开。
 *
 * @module provider-usage/useProviderUsage
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { UsageSnapshot } from '../src/types.js'
import type { SnapshotAnswer } from './fetch-snapshot.js'
import { fetchSnapshot } from './fetch-snapshot.js'
import { RESOURCE_POLL_INTERVAL_MS, usageResourceAddress } from './resource-provider.js'
import { isStaleDisplay } from './pill-format.js'
import { exhaustedResetText, headlineText } from './pill-headline.js'
import type { ProviderUsagePillProps } from './pill-types.js'

/** 手动强刷写回本地答案后压住流内旧帧的窗口：流下一帧 ≤ 一个轮询周期。 */
const MANUAL_HOLD_MS = RESOURCE_POLL_INTERVAL_MS + 5_000

/**
 * 目录尚未解析时的占位快照。
 *
 * 必须是**同一份对象**：useSyncExternalStore 要求 getSnapshot 在数据未变时返回
 * 相同引用，每次新建对象会被判定为「一直在变」而无限重渲染。本包不写这份
 * 占位值，由宿主 ModelDirectory 交付的 store 快照只读使用。
 */
const ABSENT_DIRECTORY: ModelDirectoryState = {
  current: null,
  pending: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

/** 无目录时 uSES 的空订阅。 */
function noopSubscribe(): () => void {
  return () => {}
}

export function useProviderUsage({ t, sessionId, useResource, resolveSeat }: ProviderUsagePillProps) {
  if (t === undefined) throw new Error('provider-usage: the pill requires its translation function')
  // 目录在**渲染期**解析，不在注册期（宿主自带 pill 同样如此：它们的 inject 是
  // 无参常量，会话数据走 standard kit）。resolveSeat 从不抛错，拿不到就返回
  // undefined，这一次渲染不显示，下一帧自动重试——不存在「坏 props 被永久缓存」
  // 或「render 抛错被宿主 abdicate」这两条失效路径。
  //
  // useMemo 按 (resolveSeat, sessionId) 缓存：同一会话的重渲染不该反复问服务，
  // 切换会话才重解析。
  const seat = useMemo(
    () => resolveSeat?.(sessionId),
    [resolveSeat, sessionId],
  )
  const directory = seat?.directory
  const load = seat?.load
  // subscribe/getSnapshot 引用按目录缓存：uSES 在 subscribe 引用变化时会重订阅，
  // 每帧新建闭包会让目录订阅抖动。
  const subscribe = useMemo(
    () => directory === undefined ? noopSubscribe : (listener: () => void) => directory.subscribe(listener),
    [directory],
  )
  const getSnapshot = useMemo(
    () => directory === undefined ? () => ABSENT_DIRECTORY : () => directory.getSnapshot(),
    [directory],
  )
  // Subscribe to the same per-session directory the composer's model seat
  // renders from, so a model switch moves the pill with no coordination and a
  // brand-new session (empty durable projection) still reports.
  const state = useSyncExternalStore(subscribe, getSnapshot)
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

  // 唯一数据通道：resource 流。provider 未解析时用空地址占位（该地址产空流），
  // 反正此形态下组件在函数尾部 return null 不渲染。useResource 是 hook，必须
  // 无条件调用。
  const resource = useResource(usageResourceAddress(provider ?? ''))
  // 资源快照的 value 在首个 ok 帧之后持续保留（含之后的 failed 帧），因此直接
  // 读 value：失败时展示的是最后一帧成功值，不是空白。
  const liveAnswer = resource.value
  // 流本身报 failed（协议 provider 已注册，our provider 把错误折叠成带 error
  // 字段的 ok 帧，因此这里只在协议缺失等异常态出现）→ 视为数据过期。
  const streamFailed = resource.status === 'failed'

  const [answer, setAnswer] = useState<SnapshotAnswer | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 保旧值时的“数据可能过期”信号：只有展示更早成功答案时才亮。
  const [stale, setStale] = useState(false)
  // 面板左右对齐：触发按钮靠右缘时左对齐面板会溢出视口，提前翻转。
  const [alignRight, setAlignRight] = useState(false)
  const answerRef = useRef<SnapshotAnswer | undefined>(undefined)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevOpenRef = useRef(false)
  // 手动强刷的抑制窗：force 结果写回本地 answer 并压住流里的旧帧，直到流下一帧
  // （≤60s+余量）带着宿主强刷后的新缓存值接管，强值不倒退。
  const manualUntilRef = useRef(0)

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

  // 跨闭包跟踪当前 provider:手动刷新（面板内按钮）不带 AbortSignal，provider
  // 切换时无法取消在途的旧请求——写回前必须核对响应的 provider 是否仍是当前
  // 值，否则 A 的旧余额会顶着 B 的名字显示到流下一帧。
  const providerRef = useRef(provider)
  useEffect(() => { providerRef.current = provider }, [provider])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (provider === undefined || provider === '') return
    setBusy(true)
    try {
      // 手动刷新要真刷新：force 让宿主绕过缓存读——否则流间隔与宿主 registry
      // TTL 同为 60s，按钮永远拿回上一轮的数。
      const snapshot = await fetchSnapshot(provider, signal, { force: true })
      if (mounted.current && signal?.aborted !== true && providerRef.current === provider && snapshot !== undefined) {
        answerRef.current = snapshot
        setAnswer(snapshot)
        setStale(false)
        // 流下一帧带新值接管前压住流里的旧帧，强值永不倒退。
        manualUntilRef.current = Date.now() + MANUAL_HOLD_MS
      }
    } catch (error: unknown) {
      // Keep the last good answer: a transient failure must not blank the
      // number the user is reading. Showing an older success is flagged stale.
      // 最近一次成功可能来自资源流（liveAnswer）而不是手刷，两者都算「旧值」。
      const liveGood = liveAnswer !== undefined && !('queried' in liveAnswer) && liveAnswer.error === undefined
        ? liveAnswer
        : undefined
      const previous = answerRef.current ?? liveGood
      if (previous !== undefined) {
        if (mounted.current && signal?.aborted !== true && providerRef.current === provider) setStale(true)
        return
      }
      if (mounted.current && signal?.aborted !== true && providerRef.current === provider) {
        const failed: SnapshotAnswer = { provider, windows: [], fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
        answerRef.current = failed
        setAnswer(failed)
      }
    } finally {
      // 手动刷新与旧请求并发时，迟到的旧请求不得提前关掉新请求的 busy。
      if (mounted.current && providerRef.current === provider) setBusy(false)
    }
  }, [provider, liveAnswer])

  // Provider 切换时清空手刷答案；若只是网络抖动导致 current 短暂置空、但最终
  // 恢复为同一 provider，则不清空旧答案与过期标记，避免数字闪烁与白屏。
  const activeProviderRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (provider === undefined || provider === '') return
    if (activeProviderRef.current === provider) return
    activeProviderRef.current = provider
    answerRef.current = undefined
    setAnswer(undefined)
    setStale(false)
    // 切 provider 换地址，流自动重开；抑制窗一并作废。
    manualUntilRef.current = 0
  }, [provider])

  if (provider === undefined || provider === '') return null

  // 合成答案：抑制窗内手刷值优先；其余时候流值优先（手刷答案留作流断档时的
  // 兜底，直到下一次 provider 切换清空）。
  const effectiveAnswer = Date.now() < manualUntilRef.current ? answer : (liveAnswer ?? answer)
  const queried = effectiveAnswer !== undefined && !('queried' in effectiveAnswer)
  const snapshot = queried ? effectiveAnswer as UsageSnapshot : undefined
  const isDisconnected = state.current === null && lastProviderRef.current !== undefined
  // 资源流失败、手动请求失败（保旧值）、目录重连中（current 为 null）、宿主折叠
  // 旧答案（degraded）均视为「数据可能过期」。
  const displayStale = isStaleDisplay(stale || isDisconnected || streamFailed, snapshot)
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
