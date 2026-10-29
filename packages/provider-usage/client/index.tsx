/**
 * Browser half: the provider-usage pill in the composer dock.
 *
 * The body is wrapped so an unexpected slot-API drift degrades to a console
 * error rather than throwing into the loader and raising the red "Failed to
 * load plugins" banner — the same defense the sibling packages use, because a
 * purely cosmetic pill must never be able to break the chat page.
 *
 * The guarded boundary itself is covered by the real-entry regression in
 * `test/bundle.test.ts` ("client apply() 的兜底边界对真实入口成立").
 *
 * 注册形状对齐宿主自带的 activity / usage pill（dsh-client-ui-chat 的
 * `statPillInject = () => ({ hooks: { performanceUsage } })`）：**`inject` 是无参
 * 常量函数，注册期不解析任何会话或服务状态**。宿主那两个 pill 从不失效，
 * 结构性原因就在这里——inject 里没有可能失败的步骤。
 *
 * 历史教训（2026-10-29 重构）：此前本包在注册期解析模型目录，撞上宿主两条
 * 机制，两条都表现为「pill 莫名其妙消失、刷新才好」：
 *
 * 1. `cachedSessionInject` 把 inject 结果按 (entry × 会话绑定) **永久缓存**
 *    （dsh-client-ui-renderer）——注册瞬间服务没就绪，缺 directory
 *    的坏 props 就固化到该会话整页；
 * 2. render 期抛错 → `SlotErrorBoundary` → `reportEntryError({abdicate:true})`
 *    → `SlotRegistry.abdicated`（只增不减的 WeakSet）→ 该 entry 在本注册生命周期内永久退出投影。
 *
 * 现在会话相关数据一律在**渲染期**取：组件从 standard kit 拿 `sessionId`
 * （renderer 无条件提供，永远可用），经注入的 `resolveSeat` 现解析目录。
 * 解析失败只影响这一次渲染，`resolveSeat` 永不抛错，entry 也不会被 abdicate。
 *
 * 额度数据只有一条通道：apply 里为协议 'provider-usage' 注册的
 * ResourceProvider（`resource-provider.ts`），pill 用 standard kit 的
 * `useResource` 消费。宿主 0.2.2 的 web-app bundle 恒装配
 * `@deepseek-ai/dsh-client-resources`，本包 `dsh.client.inject` 与 Cordis
 * `inject` 都把它声明为硬依赖，因此不保留「resources 缺席时组件内轮询」的
 * 退路——缺席即插件不激活、不渲染，而不是悄悄换一条数据源。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.tsx — 浏览器侧入口：注册 composer dock 的用量 pill 与 usage 资源协议
 * - resource-provider.ts — usage 的 resource 订阅面（协议注册 + live 流）
 * - ProviderUsagePill.tsx — pill 组件（只剩渲染：早退 + 展开面板）
 * - useProviderUsage.ts — 状态与取数（目录 seat、resource live 流、交互状态）
 * - WindowRow.tsx pill-types.ts — 展开面板的一行窗口、注入面与 props 类型
 * - pill-styles.ts pill-format.ts — 样式表与注入、纯格式化助手
 * - pill-headline.ts fetch-snapshot.ts — 头行文案纯函数、路由取数（fetch+解析）
 * - locales.ts — pill 文案
 *
 * @module provider-usage-client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ModelDirectory } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ProviderUsageLocaleKey } from './locales.js'
import { en, zh } from './locales.js'
import { registerProviderUsageResources } from './resource-provider.js'
import { ProviderUsagePill } from './ProviderUsagePill.js'
import type { ProviderUsagePillInjected, ProviderUsageSeat } from './pill-types.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Provider-usage pill copy. */
    'providerUsage': ProviderUsageLocaleKey
  }
}

/** Stable browser-plugin name. */
export const name = 'provider-usage-client'

/**
 * Client services to wait for.
 *
 * - `slots` — the contribution registry (`@deepseek-ai/dsh-client-ui-renderer`)；
 * - `locale` — the dictionary runtime (`@deepseek-ai/dsh-client-locale`)；
 * - `resources` — the resource model and its `useResource` standard hook
 *   (`@deepseek-ai/dsh-client-resources`)。
 *
 * 三者都是 pill 运行所必需的客户端包（`dsh.client.inject` 声明同一组包名），
 * 因此作为硬依赖等待：缺任何一个，本插件不激活，而不是换一条降级数据路径。
 * 模型目录（`modelDirectories`，dsh-client-ui-model-selection 的客户端服务）
 * 不是硬依赖——没有模型选择 UI 的部署仍应挂载本插件（只是没有可报的
 * provider），它在渲染期经 `ctx.get` 探测。
 */
export const inject = ['slots', 'locale', 'resources']

/**
 * Register the pill's copy, the usage resource protocol, and its composer-dock entry.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'providerUsage'
    ctx.effect((): (() => void) => {
      try {
        return ctx.locale.register(namespace, { zh, en })
      } catch (error: unknown) {
        // A duplicate registration (HMR/hot switch where the host already
        // holds this namespace) is ignored; anything else only warns. Letting
        // it escape would skip the slot registration below and the pill would
        // disappear entirely instead of falling back to host copy.
        const message = String((error as any)?.message ?? error)
        if (!message.includes('already')) console.warn('provider-usage: locale dictionary registration failed: ' + message)
        return () => {}
      }
    }, 'provider-usage: pill copy')
    const t = ctx.locale.bind(namespace) as ProviderUsagePillInjected['t']
    registerProviderUsageResources(ctx)
    // 照抄宿主自带 pill 的注册形状：`inject` 是一个**无参常量函数**，不解析
    // 任何会话/服务状态（dsh-client-ui-chat 的 statPillInject 即
    // `() => ({ hooks: { performanceUsage } })`）。宿主那两个 pill 从不失效的
    // 原因就在这里：inject 里没有可能失败的步骤，也就不存在「坏 props 被
    // 永久缓存」或「render 期抛错被 abdicate」这两条失效路径。
    //
    // 会话相关的数据（sessionId → 模型目录）改为由组件从 standard kit 的
    // `sessionId` 现取，走下面注入的 `resolveSeat`。standard kit 由 renderer
    // 无条件提供（dsh-client-ui-session 合并进 SessionStandardProps），永远可用。
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'provider-usage',
      // order 10 keeps this pill after the harness's own `stats` entry (order 0),
      // so the readout reads as an addition to the built-in stats rather than
      // displacing them.
      order: 10,
      // 无参、无副作用、永不抛错：与宿主 statPillInject 同形。
      inject: (): ProviderUsagePillInjected => ({
        t,
        resolveSeat: (sessionId: unknown) => resolveSeat(ctx, sessionId),
      }),
    }, ProviderUsagePill))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider registry is unaffected.
    console.error('[provider-usage] client pill failed to load (host registry unaffected):', error)
  }
}

/** Inject() 每次 slot render 都会重跑；load 闭包按目录实例缓存，避免把新
 * identity 交给组件的加载 effect（那会反复重拉目录）。 */
const loadCache = new WeakMap<ModelDirectory, () => void>()

/**
 * Resolve one session's model seat **at render time**, from the component.
 *
 * 这与宿主自带 pill 的做法一致：注册时不做任何解析，解析发生在组件渲染里，
 * 失败只影响这一次渲染，不会波及 entry 的存活。
 *
 * 三种失败都收敛成 `undefined`（组件据此这一帧不渲染），**绝不抛错**——
 * 理由见上方 apply 的注释：render 期抛错会被宿主 SlotErrorBoundary 捕获并
 * 把 entry 永久 abdicate。
 *
 * @param ctx - the browser plugin context (the apply closure's context).
 * @param sessionId - the session whose directory the dock belongs to.
 * @returns the seat, or undefined when it cannot be resolved right now.
 */
function resolveSeat(
  ctx: ClientContext,
  sessionId: unknown,
): ProviderUsageSeat | undefined {
  if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
  // 模型目录是可选服务：ctx.get 是宿主对可选服务的官方读取方式（严格模式下
  // 服务提供方 fiber 未 active 时返回 undefined）。这是**正常中间态**（插件
  // 加载顺序、服务重启），不是错误——等下一次 render 再来一次即可。
  const directories = ctx.get('modelDirectories')
  if (directories === undefined) return undefined
  let directory: ModelDirectory
  try {
    // SessionId 是宿主 branded 类型；本包不复制它的 brand，直接取声明参数类型。
    directory = directories.directoryFor(sessionId as Parameters<typeof directories.directoryFor>[0])
  } catch {
    // 会话 scope 尚未建立（重连期）/已销毁：下一帧再试。
    return undefined
  }
  let load = loadCache.get(directory)
  if (load === undefined) {
    // The model directory is lazy: `current` stays null until someone calls
    // `load()`, which the composer's own model seat does on mount. A pill that
    // only reads the snapshot would sit blank forever on a fresh session, so it
    // must request the load itself.
    load = () => { void directory.load().catch(() => {}) }
    loadCache.set(directory, load)
  }
  return {
    directory: directory.store,
    load,
  }
}
