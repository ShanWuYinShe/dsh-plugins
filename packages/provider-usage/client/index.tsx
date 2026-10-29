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
 *    （dsh-client-ui-renderer，无失效路径）——注册瞬间服务没就绪，缺 directory
 *    的坏 props 就固化到该会话整页；
 * 2. render 期抛错 → `SlotErrorBoundary` → `reportEntryError({abdicate:true})`
 *    → `SlotRegistry.abdicated`（只增不减的 WeakSet，lib/index.js:62/286/458）
 *    → 该 entry 在本注册生命周期内永久退出投影。
 *
 * 现在会话相关数据一律在**渲染期**取：组件从 standard kit 拿 `sessionId`
 * （renderer 无条件提供，永远可用），经注入的 `resolveSeat` 现解析目录。
 * 解析失败只影响这一次渲染，`resolveSeat` 永不抛错，entry 也不会被 abdicate。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.tsx — 浏览器侧入口：注册 composer dock 的用量 pill
 * - resource-provider.ts — usage 的 resource 订阅面（协议注册 + live 流）
 * - ProviderUsagePill.tsx — pill 组件（只剩渲染：早退 + 展开面板）
 * - useProviderUsage.ts — 状态与取数（订阅目录、60s 轮询、交互状态）
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
import type { SnapshotAnswer } from './fetch-snapshot.js'
import { registerProviderUsageResources, USAGE_RESOURCE_PROTOCOL } from './resource-provider.js'
import { ProviderUsagePill } from './ProviderUsagePill.js'
import type { ProviderUsagePillInjected } from './ProviderUsagePill.js'
import { en, zh } from './locales.js'
import type { ProviderUsageLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Provider-usage pill copy. */
    'providerUsage': ProviderUsageLocaleKey
  }
  /** usage 订阅面的值类型：与 route 序列化形状一致（snapshot 或未查询标记）。 */
  interface ResourceProtocolMap {
    [USAGE_RESOURCE_PROTOCOL]: SnapshotAnswer
  }
}

/** Stable browser-plugin name. */
export const name = 'provider-usage-client'

/**
 * Client modules to wait for.
 *
 * `providerUsage` is the locale namespace this package owns, not a service;
 * `slots` and `locale` are the contribution registry and the dictionary
 * service. The model directory is deliberately NOT declared here: it is an
 * optional dependency, and a deployment without the model-selection UI must
 * still load this plugin (getting the copy registered and a harmless no-op)
 * instead of a plugin that refuses to load. It is awaited on the registration
 * sub-fiber instead, so the dock entry only exists once the directory service
 * is live — see the module comment for why that order is load-bearing.
 */
export const inject = ['slots', 'locale']

/**
 * Register the pill's copy and its composer-dock entry.
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
    // usage 订阅面：resources 随宿主 web 客户端装配（匹配线 0.2.2 恒在），
    // 注册其 protocol provider 供 useProviderUsage 订阅 live 流。
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
    //
    // 连 `ctx.inject(['slots','modelDirectories'])` 这层都不再需要：它原本的唯一
    // 作用是「等目录服务就绪再注册」，而注册已经完全不依赖目录服务了。宿主自带
    // 的 activity/usage pill 同样直接 `ctx.slots.inject(...)`，不等任何可选服务。
    //
    // 目录服务缺席/未就绪只影响组件这一次渲染（resolveSeat 返回 undefined），
    // 服务晚到或重启时下一次 render 自然解析成功——不再有任何「注册时机」
    // 与「服务生命周期」耦合的地方。
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

/** The per-session directory store shape the pill renders from. */
type DirectoryStore = NonNullable<ProviderUsagePillInjected['directory']>

/** The per-session model directory the harness exposes to client plugins. */
interface ModelDirectoryLike {
  store: DirectoryStore
  load: () => Promise<unknown>
}

/** Load closures keyed by directory: inject() runs per slot render and would
 * otherwise hand the pill a fresh `load` identity each time, re-firing its
 * load effect (and the host request behind it, if the host never dedupes). */
const loadCache = new WeakMap<object, () => void>()

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
 * @param ctx - the registration sub-fiber's context (the one that declared the
 * `modelDirectories` dependency), so the lookup stays inside that fiber's scope.
 * @param sessionId - the session whose directory the dock belongs to.
 * @returns the seat, or undefined when it cannot be resolved right now.
 */
function resolveSeat(
  ctx: ClientContext,
  sessionId: unknown,
): { directory: DirectoryStore; load: () => void } | undefined {
  if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
  // The model directory is a lazy service: `current` stays null until someone
  // calls `load()`, which the composer's own model seat does on mount. A pill
  // that only reads the snapshot would sit blank forever on a fresh session,
  // so it must request the load itself.
  //
  // strict get：服务提供方 fiber 未 active 时返回 undefined（cordis
  // lib/index.js:763-771）。这是**正常中间态**（插件加载顺序、服务重启），
  // 不是错误——等下一次 render 再来一次即可。
  let directories: { directoryFor: (id: never) => ModelDirectoryLike } | undefined
  try {
    directories = ctx.get('modelDirectories') as
      | { directoryFor: (id: never) => ModelDirectoryLike }
      | undefined
  } catch {
    return undefined
  }
  if (directories === undefined) return undefined
  let directory: ModelDirectoryLike
  try {
    directory = directories.directoryFor(sessionId as never)
  } catch {
    // 会话 scope 尚未建立（重连期）/已销毁：下一帧再试。
    return undefined
  }
  let load = loadCache.get(directory)
  if (load === undefined) {
    load = () => { void directory.load().catch(() => {}) }
    loadCache.set(directory, load)
  }
  return {
    directory: directory.store,
    load,
  }
}
