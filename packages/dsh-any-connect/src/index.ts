/**
 * WorkBuddy models for DeepSeek Harness. The WorkBuddy providers reuse the
 * desktop apps' sign-in. Streaming, tool calls, compaction, and permissions
 * stay Harness-owned.
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * 入口与组装
 * - index.ts config.ts variant-runtime.ts runtime.ts runtime-sections.ts variant-wiring.ts
 *   variants.ts — 入口组装、配置 schema、变体类型与共用助手、运行时集合（构造/路由/定时器/
 *   适配器注册）、状态路由响应段（探针/目录）、变体装配（上游客户端与凭据存储，CLI 与运行时
 *   共用）、变体清单
 * 目录与额度
 * - catalog-lifecycle.ts catalog-refresh.ts catalog-adopt.ts catalog-timers.ts
 *   catalog-fingerprint.ts — 生命周期组合入口、刷新/发布/领取快通道、账号切换的目录采用、
 *   身份 sweep 与小时定时器、内容指纹
 * - catalog.ts catalog-store.ts model-filter-store.ts — 目录模型与静态兜底、每账号落盘、排除模型持久化
 * - usage.ts zcode-quota.ts zcode-builtin-catalog.ts zcode-signer.ts credit-ledger.ts — provider-usage 注册与
 *   dock 窗口助手、Coding Plan 窗口额度、ZCode 内置白名单、请求签名 V4、WorkBuddy 积分消耗台账
 *   （裂变包制的今日已用/发放/峰值，采样差分口径）
 * - zcode-plan-claim.ts zcode-plan-claim-wire.ts — Start Plan 领取（网络 I/O）与线上格式层（纯函数）
 * - zcode-plan-models.ts zcode-plan-prompt.ts zcode-plan-store.ts — 名单、请求体指纹、计划语义
 * 凭据
 * - auth.ts auth-types.ts auth-paths.ts auth-zcode.ts auth-zcode-crypto.ts auth-document.ts
 *   auth-desktop-read.ts auth-desktop-inspect.ts auth-refresh.ts auth-store.ts — 凭据解析门面与
 *   类型/路径/ZCode 解析/enc:v1 解密/文档/桌面文件读取与诊断检查/刷新策略/存储门面
 * - desktop-credential-protection.ts desktop-auth-envelope.ts desktop-discovery.ts
 *   desktop-discovery-windows.ts desktop-at-rest-key.ts desktop-app-discovery.ts wsl.ts — at-rest 凭据门面与
 *   信封/发现/密钥解析器、按平台找 Electron 二进制、WSL 判定与 Windows 路径转换
 * - state-store.ts — 自有凭据副本的状态域持久化（storageDomain）
 * 上游通道
 * - upstream.ts upstream-shared.ts upstream-types.ts — 上游门面、协议共享层（常量与助手）、
 *   协议类型（纯声明，零运行时）
 * - upstream-opencode.ts — OpenCode 客户端（官方免费通道、过闸标头与工具守卫）
 * - upstream-zcode.ts upstream-zcode-body.ts upstream-zcode-normalize.ts

 *   upstream-zcode-start-plan.ts — ZCode 客户端（通道分发与 Coding Plan）、请求体整形与兜底
 *   元数据、响应归一化（目录合流/订阅额度）、Start Plan 通道（余额/名单/领取预览）
 * - upstream-workbuddy.ts upstream-workbuddy-parse.ts upstream-workbuddy-http.ts — WorkBuddy
 *   客户端（探针与类）、纯解析（模型行/促销/计费/推理）、基址/请求头/请求体/响应信封
 * - shim.ts shim-http.ts adapter.ts reasoning-default.ts app-version.ts timeout.ts — 回环端点、
 *   HTTP 管道（读体/写错误体）、pi-ai 适配器、默认档回落（无非思考态模型补 high/最高档）、
 *   版本 UA、deadline 抽象
 * 探针与状态
 * - rate-limit.ts — 上游 429 限流观测台账（有上游明示的重置时刻才报，绝不按窗口推算）
 * - probe.ts probe-service.ts probe-store.ts probe-route.ts — 档位探测
 * - web-status.ts status-paths.ts loopback.ts host-heartbeat.ts version.ts — 同源 status 路由、
 *   路径常量、回环守卫、心跳与版本
 * 其它
 * - bin.ts — status/diagnostics CLI
 * - values.ts — 跨模块共用的 unknown 值守卫与错误文本归一
 *
 * @module dsh-any-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-settings'
import { Config } from './config.js'
import type { Options } from './config.js'
import { CreditLedger } from './credit-ledger.js'
import { createVariantRuntimeSet } from './runtime.js'
import { anyConnectDomain, domainCreditLedgerPersistence, domainStateStore } from './state-store.js'
import { WorkBuddyUpstreamClient } from './upstream.js'
import { errorMessage } from './values.js'
import { registerUsageQueriers } from './usage.js'

/** The plugin's configuration schema; the Loader reads it as the `Config` export. */
export { Config }

/** Stable Cordis plugin name. */
export const name = 'llm-anyconnect'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Start all providers: their loopback endpoints, the `workbuddy` and
 * `workbuddy-ai` providers, their configuration cards, and their
 * credential-driven catalog lifecycles.
 *
 * Each variant registers unconditionally; what varies is whether its catalog is
 * *visible*. An empty catalog is how DSH hides a model group (the host filters
 * out groups with no models), which keeps a sign-in that happens after startup
 * working without re-registering the provider.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyUpstreamClient()
  /** Live configuration snapshot: volatile references committed by the Loader
   * without a remount (read fresh on every use — caching the values would pin
   * the install-time document); install-time values where no Loader runs. */
  const current = (): Options => ({
    authFile: config.authFile.get(),
    authFileAI: config.authFileAI.get(),
    authFileZCode: config.authFileZCode.get(),
    authFileOpenCode: config.authFileOpenCode?.get(),
  })

  // 变体运行时（构造 / 路由 / 目录生命周期 / 定时器 / 适配器注册）见 runtime.ts。
  const variants = createVariantRuntimeSet({ ctx, client, current })

  // Usage readout：注册 seam 与 pill 窗口助手见 usage.ts（本文件不再持有查询器实现）。
  registerUsageQueriers(ctx, variants.runtimes, variants.rateLimits)

  // This plugin ships its own configuration cards: opt out of the host's
  // auto-generated settings page (mirroring upstream `dsh-llm-pi-ai`). The
  // inject waits for a settings service to exist — without one the plugin
  // still serves its models, as before.
  ctx.inject(['settings'], (child: Context) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  // 状态域（storageDomain）：自有凭据副本的官方持久化位（storages/dsh_any_connect/，
  // 见 state-store.ts）。服务就绪后把域存取推进每个变体；域 open 之前（注入前
  // 的 refresh 等）读写走 `.dsh-any-connect/` 下的文件回落，域就绪后以域为准。
  // 域不可用时 error 日志 + 继续文件回落——模型代理的主链路不该因持久化层
  // 故障整体不可用。
  // 宿主未挂 storage-domain 表单时 inject 永不触发，行为同回落。
  ctx.inject(['storageDomain'], child => {
    void (async () => {
      const domain = await child.storageDomain.open(anyConnectDomain)
      const state = domainStateStore(domain)
      variants.setState(state)
      // 今日消耗台账（credit-ledger.ts）与凭据副本同域（ledger 表）：域就绪即
      // 注入；open 失败时整个域走下面的统一 error 路径，台账随域一起缺席。
      variants.setLedger(new CreditLedger(domainCreditLedgerPersistence(domain)))
      ctx.effect(() => async () => {
        await domain.close()
      })
    })().catch((error: unknown) => {
      ctx.logger?.error?.(
        'dsh-any-connect: state domain unavailable; owned-copy persistence stays on the file fallback:'
        + ` ${errorMessage(error)}`,
      )
    })
  })

  // The host commits profile edits into the volatile references without a
  // remount and dispatches `loader/volatile-update` to this fiber (values are
  // already committed when it fires). Re-read the configuration and push it
  // into every variant's stores, then re-resolve each catalog: an unchanged
  // variant re-resolves to the same value and its refresh is a cheap identity
  // check, so no per-field diffing is needed. Without a Loader the
  // configuration is install-time static and this never fires.
  ctx.on('loader/volatile-update', () => variants.applyConfiguredAuthFiles())

  // 清理必须以 Promise 形式交回 cordis：宿主与测试都在 await 卸载完成，
  // 而 fire-and-forget 的两处收尾（心跳删除、shim 关闭）会与调用方的后续
  // 动作竞态——表现为临时目录删除时 ENOTEMPTY（心跳文件刚被写/删），以及
  // 测试进程里残留的监听端口。返回 Promise 后 cordis 会等它落定。
  ctx.effect(() => () => variants.dispose())

  // 两条定时器与适配器注册（shim 就绪后逐个注册）见 runtime.ts 的 start()。
  variants.start()
}
