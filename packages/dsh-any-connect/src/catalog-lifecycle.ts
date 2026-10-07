/**
 * catalog-lifecycle.ts — 目录生命周期：拉取、发布、身份核对与两条定时器。
 *
 * 2026-10-08 从 index.ts 提出（index.ts 里最大的一块）：它只依赖 ctx、凭据
 * 存储、目录与适配器句柄，不需要知道配置 schema 或路由，因此可以独立成模块。
 * 入口文件只剩「组装」：建 runtime、注册路由、把 lifecycle 接上。
 *
 * 三条职责在这里收口：
 * - refreshCatalog：身份/saved/live 三段式拉取与失败重试；
 * - publishCatalog + notifyCatalogChanged：内容真变了才通知宿主（见函数文档）；
 * - startTimers：60s 身份 sweep（含 Start Plan 领取快通道与空名单自愈）与
 *   每小时目录刷新。
 *
 * @module dsh-any-connect/catalog-lifecycle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { RegionMismatchError } from './auth.js'
import type { WorkBuddyCredential, ZCodePlanKind } from './auth.js'
import { credentialIdentity } from './catalog-store.js'
import type { WorkBuddyModelInfo } from './catalog.js'
import { filterByCodingPlanWhitelist } from './zcode-builtin-catalog.js'
import type { StartPlanPreviewResult } from './zcode-plan-claim.js'
import { fallbackFor, variantIsStartPlan } from './variant-runtime.js'
import type { VariantRuntime } from './variant-runtime.js'
import { WorkBuddyUpstreamClient, chatBase, isZCodeOffpeak } from './upstream.js'
import type { ZCodeUpstreamClient } from './upstream.js'

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
 * 目录周期刷新节拍：上游目录会漂移（促销上下线、倍率与声明档位调整、新
 * 模型），启动只拉一次的话长驻宿主会一直服务旧名单。每小时对 WorkBuddy
 * 变体重拉一次（一次免费的 catalog GET，无积分消耗）；拉取失败走既有重试，
 * 耗尽后等下个周期自然再试——「启动时网络不好就永远停在 fallback」从此
 * 不存在。unref，不拖住进程退出。
 */
const CATALOG_REFRESH_INTERVAL_MS = 60 * 60_000

/** 目录行里"会被渲染出来"的字段，按固定顺序取——顺序固定才谈得上稳定指纹。 */
const CATALOG_FINGERPRINT_BILLING_KEYS = ['credits', 'badges', 'free', 'rateUnknown'] as const

/** 一行目录参与指纹的展示字段（顺序即拼接顺序）。 */
function catalogFingerprintRow(model: WorkBuddyModelInfo): string {
  return [
    model.id,
    model.name,
    String(model.contextWindow),
    String(model.maxTokens),
    model.supportsImages === true ? '1' : '0',
    JSON.stringify(model.reasoning ?? null),
    JSON.stringify(CATALOG_FINGERPRINT_BILLING_KEYS.map(key => model.billing?.[key] ?? null)),
  ].join('\u0001')
}

/**
 * 一份**已发布目录**的内容指纹：可见性 + 每行的展示字段。
 *
 * 用于判断"这次刷新到底改没改用户看得见的东西"。取内容而非对象引用，因为
 * 每次刷新都会重建整份数组——引用比较会让每一轮定时刷新都被判成变化。
 *
 * 覆盖三件用户可见的事：某行被增删/改名/换窗口与输出上限/换图片能力/换档位
 * 集合（选择器的档位子菜单）、billing 徽标与费率（名称后缀），以及**整组是否
 * 可见**（未登录时空目录；Start Plan 今日未领取 → 空名单 → DSH 隐藏该分组）。
 * 后两者正是"名单看起来不对"最常见的两种形态，都必须通知出去。
 *
 * 刻意**不**放 `maxInputTokens` / `supportedContextWindows` / `promotions`：
 * 它们不在模型的展示名里，纳进来只会让无谓的广播变多，而"只在变化时通知"
 * 正是这条线的硬要求。
 *
 * @param models - 目录里即将发布的内容（{@link WorkBuddyCatalog.current} 的返回）。
 * @param visible - 该分组对用户是否可见。
 * @returns 稳定可比较的字符串指纹。
 */
export function catalogFingerprint(
  models: readonly WorkBuddyModelInfo[],
  visible = true,
): string {
  if (!visible) return 'hidden'
  return models.map(catalogFingerprintRow).join('\u0002')
}

/**
 * status 读路径上探测"今日待领取"的超时：卡片每 60s 轮询一次，探测只是一条
 * 提示性信息，绝不能让它拖住整份文档。3s 足够一次正常的上游往返（其余 JSON
 * 端点用的是 30s，那是**调用方等待**的场景，这里不是）。
 */
const START_PLAN_CLAIM_PROBE_TIMEOUT_MS = 3_000

/** 生命周期依赖（由 index.ts 的 apply() 提供）。 */
export interface CatalogLifecycleDeps {
  ctx: Context
  /** 无自有 client 的变体（WorkBuddy 线）用的共享客户端。 */
  client: WorkBuddyUpstreamClient
  runtimes: readonly VariantRuntime[]
  /** provider → 适配器注册句柄；目录变化时靠它通知宿主。 */
  adapterHandles: Map<string, AdapterRegistrationHandle>
  /** 插件是否已进入停止流程（dispose 置位）。 */
  isStopped: () => boolean
}

/** apply() 需要的那几件事。 */
export interface CatalogLifecycle {
  refreshCatalog(runtime: VariantRuntime, reason: string, retriesLeft?: number): void
  adoptSignedOut(runtime: VariantRuntime): void
  publishCatalog(runtime: VariantRuntime): void
  claimFlipChanged(runtime: VariantRuntime): Promise<boolean>
  claimPreviewFor(runtime: VariantRuntime): (credential: WorkBuddyCredential) => Promise<StartPlanPreviewResult>
  startTimers(): void
  stopTimers(): void
}

/** 建一套目录生命周期（每插件实例一份）。 */
export function createCatalogLifecycle(deps: CatalogLifecycleDeps): CatalogLifecycle {
  const { ctx, client, runtimes, adapterHandles, isStopped } = deps
  let sweep: ReturnType<typeof setInterval> | undefined
  let catalogTimer: ReturnType<typeof setInterval> | undefined

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
        if (identity !== runtime.lastIdentity) {
          // 账号真的换了（不是首次采用）：旧账号的探针记录不能留给新账号。
          // 首次登录不清除——那会删掉该账号自己在重启前写入的记录。
          if (runtime.lastIdentity !== undefined) runtime.probeStore!.clear()
          runtime.lastIdentity = identity
          // 该账号最好的已知目录：上次成功拉取的 saved 优先于编译期 fallback。
          // saved 是"这个账号实际被服务过"的名单，比一次性快照更可信；这同时
          // 覆盖重启场景——重启后 saved 正是阻止分组落回内置名单的东西。
          const saved = catalogStore!.saved(identity)
          if (saved !== undefined) {
            // saved 可能由**旧版本**写入（那时还没有产品面白名单），启动时会先于
            // live 拉取发布——实测 2026-10-08：升级用户的 saved 里躺着 11 个
            // Coding Plan 模型，而客户端只提供 2 个，用户会先看到一整屏越界模型。
            // 这里用与 live 同一份白名单过滤；白名单不可得则原样发布（宁可按
            // saved 展示，也不因读不到客户端文件而抹掉整组）。Start Plan 不走
            // 这条：它的 saved 是 entitlements 派生的名单，语义不同。
            const savedModels = variant.kind === 'zcode' && !variantIsStartPlan(variant)
              ? filterByCodingPlanWhitelist(saved.models, (runtime.client as ZCodeUpstreamClient | undefined)?.codingPlanWhitelist?.())
              : saved.models
            catalog.set([...savedModels])
            runtime.catalogSource = 'saved'
            runtime.catalogFetchedAtMs = saved.fetchedAtMs
          } else {
            catalog.set(fallbackFor(variant))
            runtime.catalogSource = 'fallback'
            runtime.catalogFetchedAtMs = undefined
          }
          runtime.catalogError = undefined
          // 这一拍是 saved/fallback 先行发布，不是上游的答案：空名单说明只对
          // 「live 拉取成功但零模型」成立，随后那次 live 会自己改写它。
          runtime.catalogEmpty = false
          catalog.setVisible(true)
          publishCatalog(runtime)
          // saved/fallback 目录先行发布时同样补齐缺失检测：行与旧目录不同
          // 的候选（fingerprint 失效）在这里入队；随后 live 拉取成功会再触
          // 发一次，pending 去重保证同一模型不重复跑。
          runtime.probeService?.probeMissingCandidates()
        }
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

  /** 启动身份 sweep 与目录周期刷新（两者都 unref，不拖住进程退出）。 */
  function startTimers(): void {
  // 身份与时段核对：只读 current()，身份没变就什么都不做（零上游请求）。
  // 时段交界处（夜间免费 23:00 / 09:00）自动重新同步 ZCode 目录。
  // 用 unref 的 interval，vitest 假时钟下 advanceTimers 会触发它——回调内
  // 无身份变化时不触网，现有重试计数测试不受影响。区域错配在这里静默隐藏
  // （原因已由 status 报给卡片），不每 60s 打一条告警。
  let lastOffpeak = isZCodeOffpeak()
  sweep = setInterval(() => {
    if (isStopped()) return
    const currentOffpeak = isZCodeOffpeak()
    const offpeakChanged = currentOffpeak !== lastOffpeak
    lastOffpeak = currentOffpeak

    for (const runtime of runtimes) {
      void (async () => {
        try {
          const signedIn = await runtime.store.current()
          const identity = signedIn === undefined
            ? undefined
            : credentialIdentity(signedIn as unknown as Parameters<typeof credentialIdentity>[0])
          const shouldRefresh = identity !== runtime.lastIdentity || (offpeakChanged && runtime.variant.kind === 'zcode')
          if (shouldRefresh && !isStopped()) {
            refreshCatalog(runtime, offpeakChanged ? 'offpeak boundary crossed' : 'identity sweep')
            return
          }
          // Start Plan「领取后恢复」快通道。见 claimFlipRefreshes。
          if (!isStopped() && await claimFlipChanged(runtime)) {
            refreshCatalog(runtime, 'start-plan claim flipped')
          } else if (!isStopped() && variantIsStartPlan(runtime.variant)
            && runtime.catalog.current().length === 0
            && runtime.catalogFetchedAtMs !== undefined
            && Date.now() - runtime.catalogFetchedAtMs >= EMPTY_ROSTER_SELF_HEAL_MS) {
            // 空名单自愈：领取探测一直 none（不是刚领取），但距上次拉取已超过
            // 5 分钟——上游偶尔会间歇性地答一个空活动清单（2026-10-07 实测：
            // catalog 拉得 live/empty 的同一时刻，直调同端点却有 active 活动
            // 与模型授权；余额也正常）。空名单按小时刷新兜底太久，超过阈值
            // 就再试一拍；拉完（无论结果）fetchedAtMs 都会前移，不会打环。
            refreshCatalog(runtime, 'start-plan empty roster self-heal')
          }
        } catch (error: unknown) {
          if (error instanceof RegionMismatchError) {
            if (!isStopped()) adoptSignedOut(runtime)
            return
          }
          // 核对读失败（文件瞬态不可读）不惊动：下次节拍再看。
        }
      })()
    }
  }, IDENTITY_SWEEP_MS)
  sweep.unref()

  // 目录周期刷新：上游名单漂移（促销/倍率/档位/新模型）不再依赖用户手点。
  // refreshCatalog 内部先探登录态：未登录时等价于一次身份核对，无上游请求。
  catalogTimer = setInterval(() => {
    if (isStopped()) return
    for (const runtime of runtimes) {
      refreshCatalog(runtime, 'scheduled refresh')
    }
  }, CATALOG_REFRESH_INTERVAL_MS)
  catalogTimer.unref()
  }

  /** 停掉两条定时器（dispose 时调用；可重复调用）。 */
  function stopTimers(): void {
    if (sweep !== undefined) clearInterval(sweep)
    if (catalogTimer !== undefined) clearInterval(catalogTimer)
    sweep = undefined
    catalogTimer = undefined
  }

  return { refreshCatalog, adoptSignedOut, publishCatalog, claimFlipChanged, claimPreviewFor, startTimers, stopTimers }
}
