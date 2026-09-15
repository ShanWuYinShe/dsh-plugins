/**
 * WorkBuddy models for DeepSeek Harness, reusing the WorkBuddy desktop
 * app's sign-in. Registers the `workbuddy` provider; streaming, tool calls,
 * compaction, and permissions stay Harness-owned.
 * @module dsh-any-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyCredentialStore } from './auth.js'
import { FALLBACK_WORKBUDDY_MODELS, WorkBuddyCatalog } from './catalog.js'
import { WorkBuddyCatalogStore, credentialIdentity } from './catalog-store.js'
import { createWorkBuddyAdapter, WORKBUDDY_PROVIDER } from './adapter.js'
import { createWorkBuddyShim } from './shim.js'
import { WorkBuddyUpstreamClient, chatBase } from './upstream.js'
import type { WorkBuddyWebCatalog } from './status-paths.js'
import { registerWorkBuddyStatusRoute } from './web-status.js'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.js'

export { WORKBUDDY_PROVIDER, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, createWorkBuddyAdapter, type WorkBuddyAdapter } from './adapter.js'
export { createWorkBuddyShim, type WorkBuddyShim } from './shim.js'
export {
  FALLBACK_WORKBUDDY_MODELS,
  WorkBuddyCatalog,
  type WorkBuddyModelInfo,
} from './catalog.js'
export {
  WorkBuddyCatalogStore,
  WORKBUDDY_CATALOG_FILENAME,
  credentialIdentity,
  workbuddyCatalogPath,
  type SavedWorkBuddyCatalog,
} from './catalog-store.js'
export {
  defaultDesktopAuthCandidates,
  parseWorkBuddyAuth,
  WORKBUDDY_AUTH_FILE_ENV,
  WORKBUDDY_AUTH_FILENAME,
  WorkBuddyCredentialStore,
  workbuddyOwnAuthPath,
  type WorkBuddyAuthStatus,
  type WorkBuddyCredential,
} from './auth.js'
export {
  classifyUpstreamError,
  normalizeCredits,
  prepareChatBody,
  regionOf,
  WorkBuddyUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyChatResult,
  type WorkBuddyCredits,
  type WorkBuddyEffort,
  type WorkBuddyModelBilling,
  type WorkBuddyModelReasoning,
  type WorkBuddyRefreshOutcome,
  type WorkBuddyUpstreamModel,
} from './upstream.js'
export {
  WORKBUDDY_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyHostHeartbeatPath,
  type WorkBuddyHostHeartbeat,
} from './host-heartbeat.js'

/** Stable Cordis plugin name. */
export const name = 'llm-anyconnect'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the configuration card.
 *
 * DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
 * now a nominal string, validated by the type system where it is used rather
 * than at runtime by a function call. The brand is compile-time only, so this
 * stays the plain string it always was — every comparison, descriptor lookup,
 * and `dsh` config file still sees `'anyconnect'`. It is cast once here so the
 * public constant carries the seam's type without pulling the brand helper
 * into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
 * their namespaces as plain string literals).
 */
export const WORKBUDDY_SETTINGS_NS = 'anyconnect' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy desktop auth file (defaults to the app\'s own location)'),
})

/** 目录拉取失败后的延迟重试：最多再试 2 次、间隔 60s（暂态故障自愈，耗尽即停）。 */
const CATALOG_REFRESH_RETRIES = 2
const CATALOG_REFRESH_RETRY_MS = 60_000

/**
 * 身份核对节拍：启动/authFile 变更只覆盖"当时"的登录态，之后用户在桌面
 * 端登录/登出不会自动触达这里。每 60s（与卡片轮询同频）用一次廉价的
 * `store.current()` 文件读取核对身份，变了才走完整拉取——稳态零上游请求，
 * 登录态翻转最多延迟一拍即现形。unref，不拖住进程退出。
 */
const IDENTITY_SWEEP_MS = 60_000

/**
 * Start the loopback endpoint, register the `workbuddy` provider, and
 * refresh the model catalog from the upstream once credentials allow it.
 * The static fallback catalog serves from the first moment, so an offline
 * upstream never leaves the provider empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  const store = new WorkBuddyCredentialStore({
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
    onWarning: message => ctx.logger?.warn?.(message),
  })
  const catalog = new WorkBuddyCatalog()
  const catalogStore = new WorkBuddyCatalogStore()
  const shim = createWorkBuddyShim({ store, client, catalog, logger: ctx.logger })

  // 目录来源三态（卡片"模型列表来源"行的唯一事实源）：
  // live（刚拉到）→ saved（本账号上次成功，本次拉取失败或重启后恢复）→
  // fallback（编译进插件的名单）。stopped 挡住卸载后的迟到写入。
  let catalogSource: WorkBuddyWebCatalog['source'] = 'fallback'
  let catalogFetchedAtMs: number | undefined
  let catalogError: string | undefined
  /** 上次发布过目录的账号（`uid:enterpriseId`），或从未发布时的 undefined。 */
  let lastIdentity: string | undefined

  function catalogSection(): WorkBuddyWebCatalog {
    return {
      source: catalogSource,
      ...catalogFetchedAtMs === undefined ? {} : { fetchedAt: catalogFetchedAtMs },
      ...catalogError === undefined ? {} : { error: catalogError },
    }
  }

  /** 无可用凭据：分组隐藏（空目录），而不是展示点选必错的兜底名单。
   * 行保留 fallback 内容——切回可见时无需重拉。 */
  function adoptSignedOut(): void {
    lastIdentity = undefined
    catalog.set(FALLBACK_WORKBUDDY_MODELS)
    catalog.setVisible(false)
    catalogSource = 'fallback'
    catalogFetchedAtMs = undefined
    catalogError = undefined
  }

  // Same-origin status route backing the Plugin-configuration card; the
  // webServer service is optional (a headless profile serves no browser).
  ctx.inject(['webServer'], webCtx => registerWorkBuddyStatusRoute(webCtx, {
    store,
    client,
    models: () => catalog.current(),
    catalog: catalogSection,
  }))

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it
  // keeps the configured auth-file path live across edits.
  //
  // DSH 0.1.2 moved the helper from a free function (`installSettingsSection`)
  // onto the provider service (`settings.installSection`), so the wiring now
  // has to wait for a settings service to exist — exactly what the inject
  // below does. Without one the plugin still serves its models; it simply has
  // no user-editable section, as before.
  let stopped = false
  let current = () => config
  ctx.inject(['settings'], (settingsCtx: Context) => {
    settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, {
      setSource(source: () => Config) { current = source },
      onChange() {
        const next = current().authFile
        store.setDesktopPath(next)
        // authFile 改指到另一份已登录凭据（或首次补上路径）时重拉模型目录：
        // 目录只在启动时拉一次的话，晚登录/换账号的用户会一直停在 fallback
        // 列表，直到插件重载。拉取失败仅告警，fallback 目录照常服务。
        refreshCatalog('authFile changed')
      },
    })
  })

  /** 从上游拉一次模型目录并写入 catalog；启动、authFile 变更、身份核对共用。
   * 函数声明（而非 const 箭头）：settings 服务已在场时 inject 回调同步
   * 执行，onChange 必须引用得到提升后的绑定。
   *
   * 身份语义（与上游 dsh-workbuddy-connect 的 adoptIdentity 同构）：
   * - 未登录 → 隐藏分组（adoptSignedOut），不展示兜底名单；
   * - 账号切换 → 先上该账号最好的已知目录（saved 优先于 fallback）并立即可见，
   *   再拉取 live；拉取中的旧身份迟到响应由 lastIdentity 挡掉，不覆盖新身份；
   * - 拉取失败 → 保留已发布的内容（saved/fallback），只记录 error 并按既有
   *   策略重试，重试耗尽即停。 */
  function refreshCatalog(reason: string, retriesLeft = CATALOG_REFRESH_RETRIES): void {
    void (async () => {
      try {
        // current() 只探是否已登录（未登录静默隐藏分组，不告警不重试）；
        // 真正取凭据用 resolve()：桌面文件里的 access token 过期是常态
        // （离屏很久后启动），current() 的旧 token 会让 fetchModels 必 401、
        // 目录永远停在旧快照——resolve() 会按需刷新并落盘。
        const signedIn = await store.current()
        if (signedIn === undefined || stopped) {
          if (signedIn === undefined && !stopped) adoptSignedOut()
          return
        }
        const credential = await store.resolve()
        if (stopped) return
        const identity = credentialIdentity(credential)
        if (identity !== lastIdentity) {
          lastIdentity = identity
          // 该账号最好的已知目录：上次成功拉取的 saved 优先于编译期 fallback。
          // saved 是"这个账号实际被服务过"的名单，比一次性快照更可信；这同时
          // 覆盖重启场景——重启后 hadCredential 为假，saved 正是阻止分组落回
          // 内置名单的东西。
          const saved = catalogStore.saved(identity)
          if (saved !== undefined) {
            catalog.set([...saved.models])
            catalogSource = 'saved'
            catalogFetchedAtMs = saved.fetchedAtMs
          } else {
            catalog.set(FALLBACK_WORKBUDDY_MODELS)
            catalogSource = 'fallback'
            catalogFetchedAtMs = undefined
          }
          catalogError = undefined
          catalog.setVisible(true)
        }
        const generation = lastIdentity
        const models = await client.fetchModels(credential)
        if (stopped) return
        // 拉取中账号又变了（切换/登出）：迟到响应直接丢弃，不覆盖新身份。
        if (generation !== lastIdentity) return
        catalog.set([...models])
        catalog.setVisible(true)
        catalogSource = 'live'
        catalogFetchedAtMs = Date.now()
        catalogError = undefined
        await catalogStore.save({
          account: identity,
          source: chatBase(credential),
          fetchedAtMs: catalogFetchedAtMs,
          models: [...models],
        })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        catalogError = message.slice(0, 300)
        ctx.logger?.warn?.(
          `dsh-any-connect: dynamic model catalog unavailable (${reason}); serving the last-known list`,
          error,
        )
        // 有限次延迟重试：刚启动时上游/网络暂不可达是暂态，自动恢复实时
        // 目录；重试耗尽则停在已发布的内容（saved/fallback），不再打扰。
        // 重试全程 stopped 已挡，插件卸载后的残留定时器最多空转一次。
        if (retriesLeft > 0 && !stopped) {
          setTimeout(() => { if (!stopped) refreshCatalog(`${reason}; retry`, retriesLeft - 1) }, CATALOG_REFRESH_RETRY_MS).unref()
        }
      }
    })()
  }
  ctx.effect(() => () => {
    stopped = true
    clearInterval(sweep)
    // close 期间 server 的 error 事件会 reject 该 promise,不捕获就是
    // unhandled rejection——Node 默认策略下会终止宿主进程,且恰发生在
    // dispose 路径。降级为告警日志。
    shim.close().catch(error => ctx.logger?.warn?.(`dsh-any-connect: shim close failed: ${error}`))
    void clearHostHeartbeat()
  })

  // 身份核对：只读 current()，身份没变就什么都不做（零上游请求）。
  // 用 unref 的 interval，vitest 假时钟下 advanceTimers 会触发它——回调内
  // 无身份变化时不触网，现有重试计数测试不受影响。
  const sweep = setInterval(() => {
    if (stopped) return
    void (async () => {
      try {
        const signedIn = await store.current()
        const identity = signedIn === undefined ? undefined : credentialIdentity(signedIn)
        if (identity !== lastIdentity && !stopped) refreshCatalog('identity sweep')
      } catch {
        // 核对读失败（文件瞬态不可读）不惊动：下次节拍再看。
      }
    })()
  }, IDENTITY_SWEEP_MS)
  sweep.unref()

  void shim.ready
    .then(() => {
      if (stopped) return

      try {
        // Constructed only once the listener holds a port: the provider's
        // models read the shim origin at construction time.
        const workbuddy = createWorkBuddyAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
        })

        let releaseAdapter: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDY_PROVIDER], workbuddy.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDY_PROVIDER,
            displayName: 'WorkBuddy',
            settingsNs: WORKBUDDY_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            // Registration threw; release whichever half landed.
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shim.
          releaseAdapter?.()
          releaseDirectory?.()
        }

        // The host bundle is live: write a heartbeat so the status CLI can
        // report host health without a browser. Cleared on disposal; a stale
        // heartbeat after a crash is detected by PID in the reader.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-any-connect: provider registration failed', error)
        return
      }

      refreshCatalog('startup')
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-any-connect: loopback endpoint failed to start; provider not registered', error)
    })
}
