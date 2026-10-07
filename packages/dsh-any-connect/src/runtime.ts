/**
 * runtime.ts — 变体运行时集合：构造、路由、定时器与适配器注册。
 *
 * 2026-10-08 从 index.ts 提出（入口拆分的最后一大块）：createRuntime 把一个
 * 变体的凭据存储/目录/shim/探针装起来，这里再把它们与路由、目录生命周期、
 * 适配器注册、定时器串成一套「运行时集合」。入口文件只剩 apply() 组装。
 *
 * 生命周期边界：apply() 调 {@link VariantRuntimeSet.start} 启动，卸载时调
 * {@link VariantRuntimeSet.dispose}（返回 Promise，cordis 会等它落定——见
 * dispose 内的注释）；配置热更新走 {@link VariantRuntimeSet.applyConfiguredAuthFiles}。
 *
 * @module dsh-any-connect/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { WorkBuddyCatalog } from './catalog.js'
import { FALLBACK_ZCODE_MODELS } from './catalog.js'
import { FALLBACK_ZCODE_START_PLAN_MODELS } from './zcode-plan-models.js'
import { WorkBuddyCatalogStore, workbuddyCatalogPath } from './catalog-store.js'
import { createWorkBuddyAdapter } from './adapter.js'
import { createWorkBuddyShim } from './shim.js'
import { WorkBuddyUpstreamClient } from './upstream.js'
import { ANYCONNECT_VERSION } from './version.js'
import { PROVIDER_VARIANTS } from './variants.js'
import type { WorkBuddyVariant } from './variants.js'
import { WorkBuddyProbeService } from './probe-service.js'
import { newestFirst, workbuddyProbePath, WorkBuddyProbeStore } from './probe-store.js'
import { createProbeKey, registerWorkBuddyProbeRoute } from './probe-route.js'
import { registerWorkBuddyStatusRoute } from './web-status.js'
import { applyVariantConfig, configuredAuthFile, fallbackFor, variantIsStartPlan } from './variant-runtime.js'
import type { VariantRuntime } from './variant-runtime.js'
import { createCatalogLifecycle } from './catalog-lifecycle.js'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.js'
import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './status-paths.js'
import type { Options } from './config.js'
import { createVariantCredentialStore, upstreamClientFor } from './variant-wiring.js'

/** apply() 拿到的运行时集合句柄。 */
export interface VariantRuntimeSet {
  readonly runtimes: readonly VariantRuntime[]
  /** `loader/volatile-update`：把新配置推进每个变体并重拉目录。 */
  applyConfiguredAuthFiles(): void
  /** 启动两条定时器与适配器注册（shim 就绪后逐个注册）。 */
  start(): void
  /** 卸载：停定时器、关 shim、清心跳。返回 Promise，宿主会等它落定。 */
  dispose(): Promise<void>
}

/** 建一套变体运行时（每插件实例一份）。 */
export function createVariantRuntimeSet(deps: {
  ctx: Context
  /** 无自有 client 的变体（WorkBuddy 线）用的共享客户端。 */
  client: WorkBuddyUpstreamClient
  /** 实时配置快照（Loader 提交的 volatile 引用，每次读取）。 */
  current: () => Options
}): VariantRuntimeSet {
  const { ctx, client, current } = deps
  let stopped = false

  function createRuntime(variant: WorkBuddyVariant): VariantRuntime {
    const catalog = new WorkBuddyCatalog(fallbackFor(variant), variant.kind)
    // Start hidden: a variant must serve no models until an account has actually
    // been adopted, so a signed-out variant is empty rather than showing a roster
    // whose models could only fail.
    catalog.setVisible(false)
    const configured = configuredAuthFile(current(), variant)

    if (variant.kind === 'zcode') {
      // Start Plan 是独立变体，走专属模型名单；两个变体的 transform 各自把
      // 自己的计划语义固定进读出的凭据（credential.zcodePlan 恒为该变体的
      // 计划）——模型路由（专属 vs 普通通道）、额度来源、夜免资格都只看这
      // 一个字段。共享同一份桌面凭据文档，互不掺用对方的材料。
      const zcodeClient = upstreamClientFor(variant, {
        models: variant.zcodePlanMode === 'start' ? FALLBACK_ZCODE_START_PLAN_MODELS : FALLBACK_ZCODE_MODELS,
      })
      const credentialStore = createVariantCredentialStore({
        variant,
        client: zcodeClient,
        desktopPath: configured,
        onWarning: message => ctx.logger?.warn?.(message),
      })
      const catalogStore = new WorkBuddyCatalogStore({ path: workbuddyCatalogPath(variant.catalogFilename) })
      const shim = createWorkBuddyShim({ kind: 'zcode', store: credentialStore, client: zcodeClient, catalog, logger: ctx.logger })
      const runtime: VariantRuntime = {
        variant, store: credentialStore, catalog, shim,
        client: zcodeClient, credentialStore, catalogStore,
        probeStore: undefined,
        probeService: undefined,
        catalogSource: 'fallback',
        catalogFetchedAtMs: undefined,
        catalogError: undefined,
        lastIdentity: undefined,
        // 指纹来自 catalog 的构造参数（各变体的兜底名单），所以初始值不能是
        // 'hidden'——未登录时分组本就隐藏，那会让第一次 refresh 误判成"没变"
        // 而漏掉通知。见 createRuntime 里的说明。
        publishedCatalog: '',
        catalogEmpty: false,
      }
      return runtime
    }

    const credentialStore = createVariantCredentialStore({
      variant,
      client,
      desktopPath: configured,
      onWarning: message => ctx.logger?.warn?.(message),
    })
    const catalogStore = new WorkBuddyCatalogStore({ path: workbuddyCatalogPath(variant.catalogFilename) })
    const probeStore = new WorkBuddyProbeStore({
      pluginVersion: ANYCONNECT_VERSION,
      path: workbuddyProbePath(variant.probeFilename),
    })
    const shim = createWorkBuddyShim({ kind: 'workbuddy', store: credentialStore, client, catalog, logger: ctx.logger })
    const runtime: VariantRuntime = {
      variant, store: credentialStore, catalog, shim,
      client, credentialStore, catalogStore, probeStore,
      probeService: undefined as unknown as WorkBuddyProbeService,
      catalogSource: 'fallback',
      catalogFetchedAtMs: undefined,
      catalogError: undefined,
      lastIdentity: undefined,
      // 与 ZCode 分支同理：初始指纹必须是"绝不可能等于首次发布"的哨兵。
      publishedCatalog: '',
      catalogEmpty: false,
    }
    runtime.probeService = new WorkBuddyProbeService({
      store: probeStore,
      catalog,
      credentials: credentialStore,
      client,
      // Observations are per account: the service reads and writes its records
      // against this identity, so one account's detected levels never answer
      // for another's.
      account: () => runtime.lastIdentity,
      // 清扫的探针失败必须可见:RegionMismatchError 是用户可修复的配置错误,
      // 静默吞掉会让"为什么模型没检测"无从排查。
      onSweepError: (modelId, error) => {
        ctx.logger?.warn?.(
          `[anyconnect] background probe for ${variant.id}/${modelId} failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    })
    return runtime
  }


  const runtimes = PROVIDER_VARIANTS.map(createRuntime)

  /** Per-process key authorizing probe control writes; handed to the cards. */
  const probeKey = createProbeKey()

  /**
   * 每个 provider 的适配器注册句柄（{@link AdapterRegistrationHandle}）：
   * 既是释放函数，也带着 `replace()` —— 目录变化时用它通知宿主（{@link notifyCatalogChanged}）。
   * 注册与释放在 shim 就绪回调里成对发生，这里只留"当前活着的那一个"。
   */
  const adapterHandles = new Map<string, AdapterRegistrationHandle>()

  /** 目录生命周期（拉取 / 发布 / 领取快通道 / 定时器）见 catalog-lifecycle.ts。 */
  const lifecycle = createCatalogLifecycle({
    ctx,
    client,
    runtimes,
    adapterHandles,
    isStopped: () => stopped,
  })

  function probeSection(runtime: VariantRuntime): WorkBuddyWebProbeSection {
    // 仅 WorkBuddy 变体携带探针服务；status 路由也只对它们启用 probe 字段。
    if (runtime.probeService === undefined) {
      return { running: false, results: [] }
    }
    const results = runtime.catalog.current().flatMap(info => {
      const record = runtime.probeService!.recordFor(info.id)
      if (record === undefined) return []
      return [{
        id: info.id,
        name: info.name,
        validation: record.validation,
        efforts: record.efforts,
        probedAt: record.probedAtMs,
      }]
    })
    return {
      running: runtime.probeService.isRunning(),
      results: newestFirst(results),
    }
  }

  function catalogSection(runtime: VariantRuntime): WorkBuddyWebCatalog {
    return {
      source: runtime.catalogSource,
      ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
      // 与 error 互斥：error 表示「没拉到、保留旧名单」，empty 表示「拉到了、就是空的」。
      ...runtime.catalogEmpty && runtime.catalogError === undefined ? { empty: true as const } : {},
      ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
    }
  }

  // Same-origin status routes backing each Plugin-configuration card; the
  // webServer service is optional (a headless profile serves no browser).
  ctx.inject(['webServer'], webCtx => {
    for (const runtime of runtimes) {
      registerWorkBuddyStatusRoute(webCtx, {
        path: runtime.variant.statusPath,
        store: runtime.store,
        fetchCredits: credential => runtime.client!.fetchCredits(credential as Parameters<WorkBuddyUpstreamClient['fetchCredits']>[0]),
        models: () => runtime.catalog.current(),
        catalog: () => catalogSection(runtime),
        // 探针区与档位检测只属于 WorkBuddy 变体。
        probe: () => probeSection(runtime),
        // 「今日 Start Plan 待领取」只对 Start Plan 变体探测：Coding Plan 变体
        // 没有账号计划可领，报一个恒为 none 的字段只会误导。
        ...variantIsStartPlan(runtime.variant) ? { fetchStartPlanClaim: lifecycle.claimPreviewFor(runtime) } : {},
        probeKey,
      })
      registerWorkBuddyProbeRoute(webCtx, {
        path: runtime.variant.probePath,
        refresh: async () => {
          if (stopped) return { state: 'failed' as const, reason: 'plugin is stopping' }
          // 先重读凭据：用户按刷新多半因为名单看起来不对，而最常见的
          // 原因是上次拉取后才发生的登录。重注册不需要——变的是可见性，
          // 而那归核对管。
          let credential
          try {
            credential = await runtime.store.current()
          } catch (error: unknown) {
            return {
              state: 'failed' as const,
              reason: error instanceof Error ? error.message.slice(0, 300) : String(error),
            }
          }
          if (credential === undefined) {
            lifecycle.adoptSignedOut(runtime)
            return { state: 'signed-out' as const }
          }
          lifecycle.refreshCatalog(runtime, 'manual refresh')
          return { state: 'ok' as const }
        },
      }, probeKey)
    }
  })

  /** credential/volatile-update：把新配置推给每个变体并按需重拉目录。 */
  function applyConfiguredAuthFiles(): void {
    if (stopped) return
    for (const runtime of runtimes) {
      applyVariantConfig(runtime.variant, runtime, current())
      // 凭据变化后重拉模型目录：目录只在启动时拉一次的话，晚登录/换
      // 账号的用户会一直停在旧名单，直到插件重载。拉取失败仅告警，
      // last-known 目录照常服务。
      lifecycle.refreshCatalog(runtime, 'authFile changed')
    }
  }

  /** 卸载收尾（见接口注释）。 */
  async function dispose(): Promise<void> {
    stopped = true
    lifecycle.stopTimers()
    // close 期间 server 的 error 事件会 reject 该 promise,不捕获就是
    // unhandled rejection——Node 默认策略下会终止宿主进程,且恰发生在
    // dispose 路径。降级为告警日志。
    await Promise.all(runtimes.map(async runtime => {
      try {
        await runtime.shim.close()
      } catch (error: unknown) {
        ctx.logger?.warn?.(`dsh-any-connect: shim close failed: ${error}`)
      }
    }))
    await clearHostHeartbeat()
  }

  /** 启动定时器，并在每个 shim 就绪后注册它的 provider。 */
  function start(): void {
    // 身份核对节拍（60s）与目录周期刷新（60min）两条定时器；两者的语义、
    // 领取快通道与空名单自愈的判据都在 catalog-lifecycle.ts。
    lifecycle.startTimers()

  for (const runtime of runtimes) {
    const { catalog, shim, variant } = runtime
    void shim.ready
      .then(() => {
        if (stopped) return

        try {
          // Constructed only once the listener holds a port: the provider's
          // models read the shim origin at construction time. WorkBuddy
          // speaks OpenAI completions through the shim.
          const adapter = createWorkBuddyAdapter({
            shim,
            catalog,
            providerId: variant.id,
            displayName: variant.displayName,
            api: variant.kind === 'zcode' ? 'anthropic-messages' : 'openai-completions',
            store: runtime.credentialStore!,
            recordFor: modelId => runtime.probeService?.recordFor(modelId),
            resolveAttachments: () => ctx.get('attachments'),
          })

          let releaseAdapter: AdapterRegistrationHandle | undefined
          let releaseDirectory: (() => void) | undefined
          try {
            releaseAdapter = ctx.llm.registerAdapter([variant.id], adapter.adapter)
            releaseDirectory = ctx.llm.registerConfigurableProviders([{
              provider: variant.id,
              displayName: variant.displayName,
              // Host directory entries point at the Loader profile entry id;
              // without a Loader (bare-Context installs/tests) fall back to
              // the plugin's own namespace for a stable, testable identity.
              settingsNs: ctx.fiber.entry?.options.id ?? variant.settingsNs,
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
          // 注册成功：记下句柄，目录变化时靠它通知宿主（见 notifyCatalogChanged）。
          // 与下面的释放严格成对——不记的话就是一条挂在已释放注册上的 replace。
          adapterHandles.set(variant.id, releaseAdapter)
          try {
            ctx.effect(() => () => {
              adapterHandles.delete(variant.id)
              releaseAdapter?.()
              releaseDirectory?.()
            })
          } catch {
            // The plugin was disposed during registration; release immediately —
            // the plugin-level disposer already closed the shim.
            adapterHandles.delete(variant.id)
            releaseAdapter?.()
            releaseDirectory?.()
          }
          // 注册本身就会发布 llm/adapters-updated，所以这一次通知不是多余的：
          // 客户端在启动到注册之间可能已打开过页面，缓存里存的是空目录。
          lifecycle.publishCatalog(runtime)

          // The host bundle is live: write a heartbeat so the status CLI can
          // report host health without a browser. Cleared on disposal; a stale
          // heartbeat after a crash is detected by PID in the reader.
          void writeHostHeartbeat()
        } catch (error: unknown) {
          ctx.logger.error('dsh-any-connect: provider registration failed', error)
          return
        }

        lifecycle.refreshCatalog(runtime, 'startup')
      })
      .catch((error: unknown) => {
        ctx.logger.error('dsh-any-connect: loopback endpoint failed to start; provider not registered', error)
      })
  }
  }

  return { runtimes, applyConfiguredAuthFiles, start, dispose }
}
