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
 * @module provider-usage-client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { ProviderUsagePill } from './ProviderUsagePill.js'
import type { ProviderUsagePillInjected } from './ProviderUsagePill.js'
import { en, zh } from './locales.js'
import type { ProviderUsageLocaleKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Provider-usage pill copy. */
    'providerUsage': ProviderUsageLocaleKey
  }
}

/** Stable browser-plugin name. */
export const name = 'provider-usage-client'

/**
 * Client modules to wait for.
 *
 * `providerUsage` is the locale namespace this package owns, not a service;
 * `slots` and `locale` are the contribution registry and the dictionary
 * service. The model directory is read through `ctx.get` rather than declared
 * here on purpose: a deployment without the model-selection UI still gets a
 * mounted, harmless pill instead of a plugin that refuses to load.
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
    // order 10 keeps this pill after the harness's own `stats` entry (order 0),
    // so the readout reads as an addition to the built-in stats rather than
    // displacing them.
    ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'provider-usage',
      order: 10,
      inject: (sessionId?: unknown): ProviderUsagePillInjected => {
        // The dock is session-scoped, so the renderer hands the owning session
        // here; the directory it resolves is the same one the composer's model
        // seat renders from, which is what keeps the two in agreement.
        const seat = sessionId === undefined ? undefined : modelSeat(ctx, sessionId)
        return seat === undefined ? { t } : { t, ...seat }
      },
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

/** Resolve one session's model seat, or nothing when the harness omits it. */
function modelSeat(
  ctx: ClientContext,
  sessionId: unknown,
): { directory: DirectoryStore; load: () => void } | undefined {
  // The model directory is a lazy service: `current` stays null until someone
  // calls `load()`, which the composer's own model seat does on mount. A pill
  // that only reads the snapshot would sit blank forever on a fresh session,
  // so it must request the load itself.
  const directories = ctx.get('modelDirectories') as
    | { directoryFor: (id: never) => ModelDirectoryLike }
    | undefined
  if (directories === undefined) return undefined
  try {
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
  } catch {
    // `directoryFor` is typed to the branded SessionId and rejects unknown
    // sessions; failing to resolve is a reason to render nothing, not to throw
    // into the React tree.
    return undefined
  }
}
