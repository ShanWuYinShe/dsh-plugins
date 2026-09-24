/** Browser half: WorkBuddy account status inside the DSH Plugins page. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { WorkBuddyConfigPage } from './WorkBuddyConfigPage.js'
import type { WorkBuddyConfigPageInjected } from './WorkBuddyConfigPage.js'
import { en, zh } from './locales.js'
import type { WorkBuddySettingsKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WorkBuddy plugin card copy. */
    'settings.anyconnect': WorkBuddySettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-any-connect-client'
/** Client services required by the Plugin configuration contribution. */
export const inject = ['slots', 'locale']

/**
 * Register card copy and the WorkBuddy configuration page under the Plugins
 * page.
 *
 * The entire body is wrapped so that a DSH slot-API breaking change (for
 * example the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades
 * to a `console.error` instead of throwing into the DSH loader and raising
 * the red "Failed to load plugins" banner. The host provider keeps working:
 * the `workbuddy` model channel is unaffected, and `dsh-any-connect
 * status` reports host health via the heartbeat file.
 *
 * The guarded boundary itself is covered by the real-entry regression in
 * `test/bundle.test.ts` ("client apply() 的兜底边界对真实入口成立"): it
 * imports this module and asserts a throwing slot registration never reaches
 * the loader.
 */
export function apply(ctx: ClientContext): void {
  // namespace 提到 try 之外：catch 里的占位逻辑也要用它，留在 try 内会撞 TDZ。
  const namespace = 'settings.anyconnect'
  try {
    ctx.effect((): (() => void) => {
      try {
        return ctx.locale.register(namespace, { zh, en })
      } catch (error: unknown) {
        // 重复注册（HMR/热切换下宿主已持有同 ns 字典）静默忽略，其余失败
        // 只告警——异常若穿透 effect 会跳过下面的 slots.inject，插件卡片
        // 整体消失；吞掉后文案回退到宿主默认，卡片照常渲染。
        const message = String((error as any)?.message ?? error)
        if (!message.includes('already')) console.warn('dsh-any-connect: locale dictionary registration failed: ' + message)
        return () => {}
      }
    }, 'dsh-any-connect: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyConfigPageInjected['t']
    // The bundle's configuration entry on its Plugins page. The key is the npm
    // package name the plugins.bundle.config contract dispatches by (same as
    // package.json "name" and the patch's row name); both product variants
    // (CN + WorkBuddy AI) render inside this one entry.
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: '@chaoset/dsh-any-connect',
      inject: (): WorkBuddyConfigPageInjected => ({ t }),
    }, WorkBuddyConfigPage))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-any-connect] client card failed to load (host provider unaffected):', error)
    // 无声消失不如一行静态占位：用户应知道“配置面板没加载出来”（而非
    // “本来就没有”）。占位注册本身也包一层，slot 系统整体坏掉时才放弃。
    // 文案不在这里复用外层 t：t 本身可能就是抛错点，TDZ 下引用它直接再抛；
    // 重新 bind 一次拿本地化，拿不到就用硬编码英文保底。
    let fallbackText = 'WorkBuddy config failed to load'
    try {
      fallbackText = (ctx.locale.bind(namespace) as WorkBuddyConfigPageInjected['t'])('cardLoadFailed')
    } catch {
      // locale 服务整体坏掉时保底。
    }
    try {
      const text = fallbackText
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: '@chaoset/dsh-any-connect',
        inject: () => ({}),
      }, () => text))
    } catch {
      // 连占位都挂不上去就彻底放弃（console 已留痕）。
    }
  }
}
