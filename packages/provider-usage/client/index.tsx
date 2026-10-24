/**
 * Browser half: the provider-usage pill in the composer dock.
 *
 * The body is wrapped so a DSH slot-API break degrades to a console error
 * rather than throwing into the loader and raising the red "Failed to load
 * plugins" banner — the same defense the sibling packages use, because a
 * purely cosmetic pill must never be able to break the chat page.
 *
 * The guarded boundary itself is covered by the real-entry regression in
 * `test/bundle.test.ts` ("client apply() 的兜底边界对真实入口成立").
 *
 * 注册时序（勿把解析结果固化进 slot props）：宿主 renderer 把一个 entry 的
 * `inject` 结果按 (entry × 会话绑定) **永久缓存**（dsh-client-ui-renderer 的
 * cachedSessionInject / sessionInjectCache，没有失效路径）。所以「注册 entry
 * 的那一刻目录服务是否就绪」直接决定该会话整页有没有 pill：在服务就绪前注册
 * 并解析，缺 directory 的那份 props 会被永久缓存，组件只能一直 return null，
 * 直到 entry 被重新注册——用户看到的「刷新页面 / 重开插件才行」就是这个动作。
 * 因此这里先用 `ctx.inject(['slots', 'modelDirectories'], …)` 等目录服务就绪，
 * 再在子 fiber 里注册 entry：服务消失/重启时 cordis 会销毁并重跑该子 fiber，
 * entry 随之重新注册、props 缓存重建（等价于用户手工重开插件，且自动完成）。
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
    // usage 订阅面：resources 是可选服务（GUI 装配；独立 dsh-web 部署可能
    // 没有），registerProviderUsageResources 内部探测，缺席即 no-op，pill
    // 回退 useProviderUsage 的内置轮询。
    registerProviderUsageResources(ctx)
    // 等目录服务就绪再注册 dock entry（照抄宿主 ui-model-selection 的既有写法）。
    // 子 fiber 只负责这一件事：服务未就绪时不产出任何 props，服务重启时被销毁
    // 重跑 → entry 重新注册，从而绕开渲染器对 inject 结果的永久缓存。
    ctx.inject(['slots', 'modelDirectories'], (scope) => {
      // 兜底边界因此分两层：外层 catch 管 `ctx.inject` 自身的同步抛错（含宿主
      // 没有 inject 的旧版本）；内层 catch 管子 fiber body 的抛错——body 跑在
      // cordis 的微任务边界里，调用栈已经不在 apply 的 try 内，不在这里兜住就
      // 只会落进 cordis logger，本包那句 "client pill failed to load" 就再也
      // 不会出现（兜底文案与实际行为漂移）。两层用同一句文案。
      try {
        // order 10 keeps this pill after the harness's own `stats` entry (order 0),
        // so the readout reads as an addition to the built-in stats rather than
        // displacing them.
        scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
          name: 'conversation.composer.dock',
          id: 'provider-usage',
          order: 10,
          inject: (sessionId?: unknown): ProviderUsagePillInjected => {
            // The dock is session-scoped, so the renderer hands the owning session
            // here; the directory it resolves is the same one the composer's model
            // seat renders from, which is what keeps the two in agreement.
            //
            // 注意：sessionId 为 undefined 时返回仅含 { t } 的空壳；
            // 一旦有 sessionId，必须解析会话目录。若此时目录解析抛错（如会话
            // 重连期 sessions.scope 尚未就绪），绝不可吞成 { t }——因为宿主
            // cachedSessionInject 会把 inject 结果按 (entry × 会话绑定) 永久
            // 缓存在 sessionInjectCache 里；吞成 { t } 会导致缺 directory 的
            // 残缺 props 被永久固化，整页再也长不出 pill。向外抛错能阻止坏缓存，
            // 下一帧重试即可正常拿到目录。
            if (sessionId === undefined) return { t }
            return { t, ...modelSeat(scope, sessionId) }
          },
        }, ProviderUsagePill))
      } catch (error: unknown) {
        // Degrade silently on the page: the host provider registry is unaffected.
        console.error('[provider-usage] client pill failed to load (host registry unaffected):', error)
      }
    })
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
 * Resolve one session's model seat.
 *
 * @param ctx - the registration sub-fiber's context (the one that declared the
 * `modelDirectories` dependency), so the lookup stays inside that fiber's scope.
 * @param sessionId - the session whose directory the dock belongs to.
 */
function modelSeat(
  ctx: ClientContext,
  sessionId: unknown,
): { directory: DirectoryStore; load: () => void } {
  // The model directory is a lazy service: `current` stays null until someone
  // calls `load()`, which the composer's own model seat does on mount. A pill
  // that only reads the snapshot would sit blank forever on a fresh session,
  // so it must request the load itself.
  const directories = ctx.get('modelDirectories') as
    | { directoryFor: (id: never) => ModelDirectoryLike }
    | undefined
  if (directories === undefined) {
    throw new Error('provider-usage: modelDirectories service unavailable during session inject')
  }
  const directory = directories.directoryFor(sessionId as never)
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
