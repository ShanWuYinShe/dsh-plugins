/**
 * useProviderUsage.ts — 状态与取数（目录 seat + resource live 流 + 交互状态）
 *
 * 额度数据只有一条通道：本包在 apply 里为协议 'provider-usage' 注册的
 * ResourceProvider，经宿主 standard kit 的 `useResource(address)` 订阅 live
 * 流（首帧立即、之后每 65s 由 provider 侧取一次、有变化才推帧）。组件内
 * 不再有轮询定时器、唤醒监听或第二条取数路径；provider 切换即换地址、
 * 流自动重开。
 *
 * 目录快照走官方 inject `keyedHooks`（renderer 绑定成 `useModelDirectory`），
 * 组件不持有 uSES 订阅机器（RULE-065/068）。手动刷新只是**第二个观测源**：
 * 流值与手刷值按 fetchedAt 比较谁更晚用谁（没有墙钟抑制窗）。
 *
 * 防御姿态（RULE-079）：缺 `t`（宿主 inject 契约漂移）不抛错，退回包内英文
 * 字典继续渲染；缺 locale 钩子退回浏览器默认格式化。两者都只降低语言保真度，
 * 不让 render 抛错把 entry 永久移出投影。
 *
 * @module provider-usage/useProviderUsage
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { fetchSnapshot, isQueriedAnswer, type SnapshotAnswer } from './fetch-snapshot.js'
import { fallbackTranslate } from './locales.js'
import { usageResourceAddress } from './resource-provider.js'
import { isStaleDisplay } from './pill-format.js'
import { exhaustedResetText, headlineText } from './pill-headline.js'
import { rateLimitForCurrentModel } from './pill-rate-limit-scope.js'
import type { ProviderUsagePillProps } from './pill-types.js'

/**
 * 一份答案的观测时刻；「该 provider 未注册查询器」标记没有 fetchedAt，视为最旧。
 *
 * 两个数据源（resource 流、手动 force 刷新）只按这个时刻决定谁更新——不用
 * 墙钟抑制窗：弱网迟到的一帧旧流值 fetchedAt 更早，不会覆盖刚手刷到的新值。
 */
function observedAt(answer: SnapshotAnswer | undefined): number {
  return answer !== undefined && isQueriedAnswer(answer) ? answer.fetchedAt : Number.NEGATIVE_INFINITY
}

/**
 * 目录尚未解析时的占位快照。
 *
 * 必须是**同一份对象**：renderer 的 keyed hook 内部用 uSES，getSnapshot 在
 * 数据未变时必须返回相同引用，每次新建对象会被判定为「一直在变」而无限重渲染。
 * 本包不写这份占位值，由宿主 ModelDirectory 交付的 store 快照只读使用。
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

export function useProviderUsage({ t, sessionId, useResource, resolveSeat, useLocale, useModelDirectory }: ProviderUsagePillProps) {
  // 注入面漂移（宿主契约变更、延迟注入）时 t 可能缺席。此前这里直接 throw：
  // render 期抛错会被宿主 `SlotErrorBoundary` → `reportEntryError({abdicate:true})`
  // 永久移出投影，pill 再也不显示——恰好是「绝不让 pill 弄坏页面」要防的失效路径。
  // 现在只记一次 console.error，退回包内 en 字典继续渲染：例外只影响语言，
  // 不影响 entry 存活，也不把错误推给全局。
  const warnedMissingTranslation = useRef(false)
  if (t === undefined && !warnedMissingTranslation.current) {
    warnedMissingTranslation.current = true
    console.error('provider-usage: pill missing translation seat; falling back to English copy')
  }
  const copy = t ?? fallbackTranslate
  // locale 快照 hook（宿主 renderer 由 inject.hooks.locale 绑定）：跟随 DSH
  // 当前语言做数字/时间格式化，而不是浏览器语言。缺席（旧宿主/契约漂移）时
  // 退回浏览器默认 locale，格式化仍可用；该 hook 的在场性由宿主缓存的 inject
  // 面决定，同一组件实例内恒定，不破坏 hook 调用顺序。
  const localeId = typeof useLocale === 'function' ? useLocale(snapshot => snapshot.active) : undefined
  // 会话 key：renderer 的 keyed hook 按它解析目录；无会话时用空串（resolver
  // 返回 undefined，hook 也返回 undefined）。
  const sessionKey = typeof sessionId === 'string' ? sessionId : ''
  // 目录快照走官方 keyed hook：renderer 用它自己的 uSES 订阅注入面提供的
  // ModelDirectory.store（与 composer 模型选择器同源），业务组件不持有任何
  // 订阅机器（RULE-065/068）。hook 缺席/目录解析失败 → 这一帧按无目录处理，
  // 组件不渲染但绝不抛错；下一次 render 自动重试。
  const state = useModelDirectory?.(sessionKey) ?? ABSENT_DIRECTORY
  // 惰性目录加载入口仍是普通注入回调（无订阅语义）：目录是 lazy 的，current
  // 首次读取前恒为 null，没人 load 的话 pill 永远空白。
  const load = useMemo(
    () => resolveSeat?.(sessionId)?.load,
    [resolveSeat, sessionId],
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
  // 当前选中的模型 id：限流是**按模型**的上游事实（WorkBuddy 各模型 cap-hit
  // 独立记账），而 pill 是 provider 级表面。换了同一 provider 下的另一个模型后，
  // 原模型被限的事实不该继续挂在 pill 上——那会把「A 被限」读成「整条通道不可用」。
  // 目录未解析（current 为 null）或宿主未给 model 时保持 undefined，视为未知。
  const currentModel = state.current?.model
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

  // 手刷答案（显式观测源）：成功时写回宿主 force 后的答案，失败时只保留旧值/
  // 失败占位；与流值的取舍见下方 effectiveAnswer。
  const [manualAnswer, setManualAnswer] = useState<SnapshotAnswer | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // 保旧值时的“数据可能过期”信号：只有展示更早成功答案时才亮。
  const [stale, setStale] = useState(false)
  // 面板左右对齐：触发按钮靠右缘时左对齐面板会溢出视口，提前翻转。
  const [alignRight, setAlignRight] = useState(false)
  const manualAnswerRef = useRef<SnapshotAnswer | undefined>(undefined)
  const mounted = useRef(true)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const prevOpenRef = useRef(false)

  // 组件卸载后不再写回异步结果；StrictMode 的 mount→cleanup→mount 需要重新置 true。
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
    // 写回守卫：已卸载 / 已取消 / provider 已切换时，这次请求的结果一律作废。
    const canApply = (): boolean => mounted.current && signal?.aborted !== true && providerRef.current === provider
    setBusy(true)
    try {
      // 手动刷新要真刷新：force 让宿主绕过缓存读。自动轮询要等下一个节拍
      // （60s + 相位余量）才重读，按钮必须立刻打一次上游。
      const fetched = await fetchSnapshot(provider, signal, { force: true })
      if (canApply() && fetched.answer !== undefined) {
        // 手刷值写回为**一个观测**：它的 fetchedAt 来自宿主，比流里的旧帧晚；
        // 之后的流帧只要 fetchedAt 更晚就自然接管。不再有按墙钟维持的抑制窗。
        manualAnswerRef.current = fetched.answer
        setManualAnswer(fetched.answer)
        setStale(false)
      }
    } catch (error: unknown) {
      // Keep the last good answer: a transient failure must not blank the
      // number the user is reading. Showing an older success is flagged stale.
      // 最近一次成功可能来自资源流（liveAnswer）而不是手刷，两者都算「旧值」。
      const liveGood = isQueriedAnswer(liveAnswer) && liveAnswer.error === undefined ? liveAnswer : undefined
      const previous = manualAnswerRef.current ?? liveGood
      if (previous !== undefined) {
        if (canApply()) setStale(true)
        return
      }
      if (canApply()) {
        const failed: SnapshotAnswer = { provider, windows: [], fetchedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }
        manualAnswerRef.current = failed
        setManualAnswer(failed)
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
    // 切 provider 换地址，流自动重开；手刷观测属于旧 provider，一并作废。
    manualAnswerRef.current = undefined
    setManualAnswer(undefined)
    setStale(false)
  }, [provider])

  if (provider === undefined || provider === '') return null

  // 两个观测源按**观测时刻**合并：谁更晚用谁。弱网下迟到的旧流帧（fetchedAt
  // 早于手刷值）不会把刚刷新的数字顶回去；宿主在 force 之后产出的新流帧
  // （fetchedAt 更晚）自然接管，无需墙钟窗口。两者都没有时返回 undefined。
  const effectiveAnswer = observedAt(liveAnswer) >= observedAt(manualAnswer) ? liveAnswer ?? manualAnswer : manualAnswer
  const queried = isQueriedAnswer(effectiveAnswer)
  const snapshot = queried ? effectiveAnswer : undefined
  const isDisconnected = state.current === null && lastProviderRef.current !== undefined
  // 资源流失败、手动请求失败（保旧值）、目录重连中（current 为 null）、宿主折叠
  // 旧答案（degraded）均视为「数据可能过期」。
  const displayStale = isStaleDisplay(stale || isDisconnected || streamFailed, snapshot)
  // 限流归属只看当前选中模型：与选中项无关的观测在这里就被摘掉，头行、圆点、
  // 展开面板因此共用同一份判定，不会出现「头行说限流、面板说别的模型」。
  const rateLimit = rateLimitForCurrentModel(snapshot?.rateLimit, currentModel)
  const headline = headlineText(
    snapshot === undefined ? effectiveAnswer : { ...snapshot, ...rateLimit === undefined ? { rateLimit: undefined } : { rateLimit } },
    provider,
    displayStale,
    copy,
    localeId,
  )
  // 额度用尽时补「几点恢复」：这是用户「到什么时候能接着用」的直接答案。
  // 只在真用尽（remain === 0 且有 resetsAt）时出现，有余额时不打扰。
  const resetHint = snapshot === undefined ? undefined : exhaustedResetText(snapshot, copy, localeId)

  return {
    t: copy,
    localeId,
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
    rateLimit,
    headlineText: headline,
    resetHint,
  }
}
