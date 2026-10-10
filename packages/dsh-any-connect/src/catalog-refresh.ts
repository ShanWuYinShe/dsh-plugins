/**
 * catalog-refresh.ts — 目录刷新与发布：身份/saved/live 三段式拉取与重试。
 *
 * 2026-10-08 从 catalog-lifecycle.ts 拆出：refreshCatalog 与它调用的
 * adoptSignedOut / publishCatalog / notifyCatalogChanged、Start Plan 领取快通道
 * 同属一条链路；方法体逐字保留。
 *
 * @module dsh-any-connect/catalog-refresh
 */

import { RegionMismatchError, type WorkBuddyCredential, type ZCodePlanKind } from './auth.js'
import { credentialIdentity } from './catalog-store.js'
import { filterByCodingPlanWhitelist } from './zcode-builtin-catalog.js'
import type { StartPlanPreviewResult } from './zcode-plan-claim.js'
import { fallbackFor, variantIsStartPlan, type VariantRuntime } from './variant-runtime.js'
import { WorkBuddyUpstreamClient, chatBase, type ZCodeUpstreamClient } from './upstream.js'
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { catalogFingerprint } from './catalog-fingerprint.js'
import { adoptIdentity } from './catalog-adopt.js'

/** 刷新模块依赖（由 catalog-lifecycle 透传）。 */
export interface CatalogRefreshDeps {
  ctx: Context
  client: WorkBuddyUpstreamClient
  runtimes: readonly VariantRuntime[]
  adapterHandles: Map<string, AdapterRegistrationHandle>
  isStopped: () => boolean
}

/** 目录刷新与发布（外加 timers 需要的空名单自愈阈值）。 */
export interface CatalogRefresh {
  refreshCatalog(runtime: VariantRuntime, reason: string, retriesLeft?: number): void
  adoptSignedOut(runtime: VariantRuntime): void
  publishCatalog(runtime: VariantRuntime): void
  claimFlipChanged(runtime: VariantRuntime): Promise<boolean>
  claimPreviewFor(runtime: VariantRuntime): (credential: WorkBuddyCredential) => Promise<StartPlanPreviewResult>
  /** 空名单自愈阈值（sweep 的判据，见 catalog-timers）。 */
  emptyRosterSelfHealMs: number
}

export function createCatalogRefresh(deps: CatalogRefreshDeps): CatalogRefresh {
  const { ctx, client, runtimes, adapterHandles, isStopped } = deps

/** 目录拉取失败后的延迟重试：最多再试 2 次、间隔 60s（暂态故障自愈，耗尽即停）。 */
const CATALOG_REFRESH_RETRIES = 2
const CATALOG_REFRESH_RETRY_MS = 60_000

/**
 * status 读路径上探测"今日待领取"的超时：卡片每 60s 轮询一次，探测只是一条
 * 提示性信息，绝不能让它拖住整份文档。3s 足够一次正常的上游往返（其余 JSON
 * 端点用的是 30s，那是**调用方等待**的场景，这里不是）。
 */
const START_PLAN_CLAIM_PROBE_TIMEOUT_MS = 3_000

  /**
   * Start Plan 的「上拍还可领、这拍已领走」标记（每变体一份）。
   *
   * 只用于**跳变判定**，不作为任何展示判断——false 既可能是「已领取」也可能是
   * 「没探到」（探测失败不写它）。
   */
  const claimWasAvailable = new Map<string, boolean>()

  /**
   * 空名单自愈阈值：Start Plan 目录为空且领取探测无翻转时，距上次拉取超过
   * 该时长就在 sweep 里再拉一拍。上游偶发地答一个空活动清单(间歇抖动)时,
   * 小时刷新要等一整小时,5 分钟自愈把分组消失的时间压到分钟级;拉取本身
   * 无论结果都会前移 fetchedAtMs,不会形成每拍重拉的循环。
   */
  const EMPTY_ROSTER_SELF_HEAL_MS = 5 * 60_000

  /**
   * Start Plan 的廉价状态翻转快通道：目录为空时探一次「今天还能不能领」
   * （{@link claimPreviewFor}，纯 HTTP、无 captcha、3s 超时），返回「是否刚刚
   * 从可领翻到不可领」——那正是**用户刚领完**的唯一信号。
   *
   * 为什么需要它：用户领取既不改变凭据身份、也不落在夜免边界上，身份 sweep 的
   * shouldRefresh 恒为假；而 Start Plan 专属通道的模型名单就是「今天领到了什么」
   * （见 zcode-plan-models），没领时上游返回空。于是「今日未领取 → 用户在客户端
   * 领取」这段时间里分组会一直空着，直到下一次小时刷新——用户以为要等一小时。
   * 这条快通道把恢复压到一拍（≤60s）。
   *
   * **稳态零额外请求**：目录非空就完全不探测。目录非空 = 今天已经领到了，
   * 常规的小时刷新足够覆盖上游漂移，不需要在这里再问一次。
   *
   * 探测失败（含超时/无凭据/上游报错）一律当作**没探到**：既不触发刷新，也不
   * 改动标记——避免一次网络抖动既打无谓的上游请求、又把下一拍的判断搅乱。
   * 异常绝不冒泡：sweep 里其它变体与身份核对照常进行。
   */
  async function claimFlipChanged(runtime: VariantRuntime): Promise<boolean> {
    const { variant } = runtime
    if (!variantIsStartPlan(variant)) return false
    // 有模型 = 今天已经领到，快通道无事可做（也就零额外请求）。
    if (runtime.catalog.current().length > 0) {
      claimWasAvailable.delete(variant.id)
      return false
    }
    let preview: StartPlanPreviewResult
    try {
      const signedIn = await runtime.store.current()
      if (signedIn === undefined) return false
      const credential = await runtime.store.resolve() as WorkBuddyCredential
      preview = await claimPreviewFor(runtime)(credential)
    } catch {
      // 凭据读不到 / 探测抛错 / 超时：一律「没探到」，不刷新也不改标记。
      return false
    }
    if (preview.status !== 'ok') return false
    const available = preview.plans.length > 0
    const previous = claimWasAvailable.get(variant.id)
    claimWasAvailable.set(variant.id, available)
    // 上一拍还能领、这一拍不能领了 = 用户刚完成领取。
    return previous === true && !available
  }

  /**
   * Start Plan 变体的领取提示探测器。
   *
   * **必须短超时**：它挂在卡片每 60s 轮询的 status 读路径上，一个挂死的上游
   * 不能让整份文档等着。所以这里先包一层 `AbortSignal.timeout`——探不到就是
   * `unknown`（web-status 收敛），而不是把 status 拖成 500。
   *
   * 每次探测都**重新读凭据**：用户刚在客户端登录/换号后，卡片最多一拍即能
   * 看到新的可领状态，不需要重载插件。
   */
  function claimPreviewFor(runtime: VariantRuntime): (credential: WorkBuddyCredential) => Promise<StartPlanPreviewResult> {
    const zcodeClient = runtime.client as ZCodeUpstreamClient
    return credential => zcodeClient.fetchStartPlanClaimPreview(credential, {
      signal: AbortSignal.timeout(START_PLAN_CLAIM_PROBE_TIMEOUT_MS),
    })
  }

  /** 无可用凭据：分组隐藏（空目录），而不是展示点选必错的兜底名单。
   * 行保留 fallback 内容——切回可见时无需重拉。曾登录过的账号离开时，其
   * 探针记录一并清除（与上游一致：不能让新账号继承旧账号的检测档位）。 */
  function adoptSignedOut(runtime: VariantRuntime): void {
    if (runtime.lastIdentity !== undefined) runtime.probeStore?.clear()
    runtime.lastIdentity = undefined
    runtime.catalog.set(fallbackFor(runtime.variant))
    runtime.catalog.setVisible(false)
    runtime.catalogSource = 'fallback'
    runtime.catalogFetchedAtMs = undefined
    runtime.catalogError = undefined
    // 未登录不是「上游说没有模型」：那张卡片该说的是「去登录」，不是空名单说明。
    runtime.catalogEmpty = false
    publishCatalog(runtime)
  }

  /**
   * 目录内容变化 → 通知宿主"适配器拓扑变了"，正在开着的聊天页当场重拉模型
   * 选择框的名单。这是"模型列表实时更新"的全部接线，见 {@link notifyCatalogChanged}。
   *
   * **只在内容真的变了时通知**：宿主每小时都会重拉一次目录
   * （{@link CATALOG_REFRESH_INTERVAL_MS}），多数时候名单一模一样；无条件通知会让
   * 每个打开的客户端每小时白重拉一次目录、白重渲染一次选择框。指纹取内容
   * （{@link catalogFingerprint}），不能用数组引用——每次刷新都会重建整份数组。
   *
   * 快照取 `current()`：可见 → 与适配器此刻服务给宿主的行完全一致；不可见 → 空，
   * 与宿主看到的空分组一致（这正是"Start Plan 今日未领取就该隐藏分组"那次变化）。
   * 必须在本次发布**之后**调用，否则会把刚写进去的内容判成"没变"而漏掉通知。
   */
  function publishCatalog(runtime: VariantRuntime): void {
    const visible = runtime.catalog.isVisible()
    const fingerprint = catalogFingerprint(visible ? runtime.catalog.current() : [], visible)
    if (fingerprint === runtime.publishedCatalog) return
    runtime.publishedCatalog = fingerprint
    notifyCatalogChanged(runtime.variant.id)
  }

  /**
   * 通知宿主「该 provider 的目录内容变了」，正在打开的客户端随之重拉模型列表。
   *
   * 为什么走 `handle.replace()`：客户端（dsh-client-ui-model-selection 的
   * `ModelCatalogDirectory`）只在四个远程事件上重拉目录，其中
   * `llm/adapters-updated` 是我们能触发的那个；而它**缓存命中即直接返回**，
   * 收不到事件就一直展示打开页面那一刻的旧名单，直到用户刷新页面。
   * 该事件由 `dsh-llm` 私有的 `emitAdaptersUpdated` 发布，插件不能直接调——但
   * `AdapterRegistrationHandle.replace` 的 JSDoc 明说路由集唯一的变更点正是
   * 发布该事件的地方，所以"用同样的路由替换自己"就是公开的正式通知手段
   * （空数组也是合法替换，而初始注册不接受空列表）。**不要另造事件**。
   *
   * 容错：插件卸载、或注册与通知之间的竞态，都会让 `replace` 抛
   * `LlmError REGISTRATION_DISPOSED`（注册已释放，路由没了）。这是正常路径，
   * 吞掉即可——为一次目录通知打断 refreshCatalog 才是错的。
   */
  function notifyCatalogChanged(provider: string): void {
    // shim 还没监听、或注册已释放：这条目录等注册那次通知自己可见，不额外补一发。
    const handle = adapterHandles.get(provider)
    if (handle === undefined) return
    try {
      handle.replace([provider])
    } catch (error: unknown) {
      ctx.logger?.debug?.(`dsh-any-connect: ${provider} adapter registration is gone; catalog update not announced: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  /** 从上游拉一次模型目录并写入 catalog；启动、配置变更、身份核对共用。
   * 函数声明（而非 const 箭头）：`loader/volatile-update` 处理器引用它，
   *
   * 身份语义（与上游 dsh-workbuddy-connect 的 adoptIdentity 同构）：
   * - 未登录 → 隐藏分组（adoptSignedOut），不展示兜底名单；
   * - 区域错配 → 同样隐藏分组，但不重试（重试修不好配错的文件），原因
   *   由 status 的 reason 字段报给卡片；
   * - 账号切换 → 先上该账号最好的已知目录（saved 优先于 fallback）并立即可见，
   *   再拉取 live；拉取中的旧身份迟到响应由 lastIdentity 挡掉，不覆盖新身份；
   * - 拉取失败 → 保留已发布的内容（saved/fallback），只记录 error 并按既有
   *   策略重试，重试耗尽即停。 */
  function refreshCatalog(runtime: VariantRuntime, reason: string, retriesLeft = CATALOG_REFRESH_RETRIES): void {
    const { store, catalog, catalogStore, variant } = runtime
    const retry = (left: number): void => {
      if (left > 0 && !isStopped()) {
        setTimeout(() => { if (!isStopped()) refreshCatalog(runtime, `${reason}; retry`, left - 1) }, CATALOG_REFRESH_RETRY_MS).unref()
      }
    }
    void (async () => {
      try {
        // current() 只探是否已登录（未登录静默隐藏分组，不告警不重试）；
        // 真正取凭据用 resolve()：桌面文件里的 access token 过期是常态
        // （离屏很久后启动），current() 的旧 token 会让 fetchModels 必 401、
        // 目录永远停在旧快照——resolve() 会按需刷新并落盘。
        const signedIn = await store.current()
        if (signedIn === undefined || isStopped()) {
          if (signedIn === undefined && !isStopped()) adoptSignedOut(runtime)
          return
        }
        const credential = await store.resolve()
        if (isStopped()) return
        // WorkBuddy 凭据带 uid/enterpriseId；RuntimeStore 的结构最小化类型
        // 只承诺 accessToken，这里按 kind 已分流的前提下还原完整形状。
        const identity = credentialIdentity(credential as unknown as Parameters<typeof credentialIdentity>[0])
        // 夜间免费是 Coding Plan 的权益，Start Plan 不享受。两个 ZCode 变体
        // 是独立产品，各自的凭据 transform 已固定 zcodePlan，资格随之而定。
        if (variant.kind === 'zcode') {
          catalog.setNightFreeEligible(
            (credential as unknown as { zcodePlan?: ZCodePlanKind }).zcodePlan !== 'start-plan',
          )
        }
        if (identity !== runtime.lastIdentity) await adoptIdentity(runtime, identity, publishCatalog)
        const generation = runtime.lastIdentity
        const models = await (runtime.client ?? client).fetchModels(credential as Parameters<WorkBuddyUpstreamClient['fetchModels']>[0])
        if (isStopped()) return
        // 拉取中账号又变了（切换/登出）：迟到响应直接丢弃，不覆盖新身份。
        if (generation !== runtime.lastIdentity) return
        catalog.set([...models])
        catalog.setVisible(true)
        // 本次刷新真正落到用户眼前的那一行：内容变了才通知宿主（见 publishCatalog）。
        publishCatalog(runtime)
        runtime.catalogSource = 'live'
        runtime.catalogFetchedAtMs = Date.now()
        runtime.catalogError = undefined
        // 上游明确答「什么都没有」：这不是错误，是要如实说出来的结论。
        runtime.catalogEmpty = models.length === 0
        // 空名单是**有效的降级观测**（Start Plan 今日未领取/活动已过期：上游查询
        // 成功但没有任何有效活动），它只该影响本轮的 UI——空目录即 DSH 隐藏该分组。
        // 但它**不是可持久化的观测**：catalogStore 是"上次真正加载过的名单"，
        // 存下空名单会让下次启动的 saved 分支把空目录当已知好状态发布，一旦那时
        // live 拉取再失败（catch 停在 saved），用户就长期看不到这个分组——而这
        // 恰恰是 saved 存在的目的（重启后别落回内置名单）。所以空名单不写盘。
        if (models.length > 0) {
          await catalogStore!.save({
            account: identity,
            source: variant.kind === 'zcode' ? 'https://open.bigmodel.cn' : chatBase(credential as unknown as Parameters<typeof chatBase>[0]),
            fetchedAtMs: runtime.catalogFetchedAtMs,
            models: [...models],
          })
        }
        // 目录落地即补齐缺失的档位检测（仅当用户开启过自动检测）：新模型、
        // 行变化导致旧记录失效的模型，都在这里自动入队。
        runtime.probeService?.probeMissingCandidates()
      } catch (error: unknown) {
        if (error instanceof RegionMismatchError) {
          // 配错了文件：隐藏分组并把原因留给卡片，不重试。
          if (!isStopped()) {
            adoptSignedOut(runtime)
            runtime.catalogError = undefined
            ctx.logger?.warn?.(`dsh-any-connect: ${variant.displayName} ${error.message}`)
          }
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        // 拉取失败 = 没拉到（保留上一份名单），不是「拉到了空的」。
        runtime.catalogEmpty = false
        runtime.catalogError = message.slice(0, 300)
        ctx.logger?.warn?.(
          `dsh-any-connect: dynamic model catalog unavailable (${variant.id}; ${reason}); serving the last-known list`,
          error,
        )
        // 有限次延迟重试：刚启动时上游/网络暂不可达是暂态，自动恢复实时
        // 目录；重试耗尽则停在已发布的内容（saved/fallback），不再打扰。
        // 重试全程 stopped 已挡，插件卸载后的残留定时器最多空转一次。
        retry(retriesLeft)
      }
    })()
  }

  return {
    refreshCatalog,
    adoptSignedOut,
    publishCatalog,
    claimFlipChanged,
    claimPreviewFor,
    emptyRosterSelfHealMs: EMPTY_ROSTER_SELF_HEAL_MS,
  }
}
