/**
 * apply.ts — 插件主体：把配置的额外可写根并入官方 sandbox 策略，并注册设置页服务。
 *
 * enforcement 收敛到官方：`policy-merge.ts` 包装 `ctx.sandboxPolicy.resolve()`，
 * 官方 Seatbelt / bwrap / Landlock / fs fence 从同一 `additionalWritableRoots`
 * 消费（本插件不再包装 `ctx.fs.checkedTarget`、不再改写 confine argv）。
 * 本模块只做配置解析、包装装配与 Remote 服务注册；目录存在性过滤复用
 * roots-filter 的实例缓存，危险根/规范化在 config-validate。
 *
 * 官方依赖（@deepseek-ai/dsh-sandbox-policy 等）一律静态导入：宿主的外部插件
 * 运行时解析保证单实例，没有 createRequire 多级 fallback 与模块求值期 await。
 *
 * @module @chaoset/sandbox-extra-roots/apply
 */

import type { Context } from '@deepseek-ai/cordis'
import { createRootsFilter } from './roots-filter.js'
import { normalizeRoots } from './config-validate.js'
import { DEFAULT_CONFIG } from './plugin-config.js'
import { policyMerge, rawPolicyService } from './policy-merge.js'
import { PluginConfigGateway } from './remote.js'
import type { Config } from './config.js'
import type { SandboxExtraRootsConfig, SandboxExtraRootsDegraded } from './types.js'

export async function apply(ctx: Context, config?: Config): Promise<void> {
  const warn = (message: string) => ctx.logger?.warn?.(message)
  // 生效配置：defaults 与 cordis 注入的 patch config（设置页保存经官方
  // configEditor 写入，由 Loader 对账后 reload 本行使新配置在这里生效）。
  const cfg: SandboxExtraRootsConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  // 降级可见性（RULE-061）：初始化失败时额外根不生效，但设置卡必须能显示
  // 原因——gateway 仍注册，get() 返回 degraded。
  let degraded: SandboxExtraRootsDegraded | undefined
  try {
    // 目录存在性 TTL 缓存是实例级状态（owner: 本次 apply 的包装句柄）。
    const rootsFilter = createRootsFilter()
    const policy = rawPolicyService(ctx.sandboxPolicy)
    const merge = policyMerge(policy, { rootsFilter, warn })
    // 挂载计数在 effect 体内递增，且 effect 先于包装安装登记：
    //   - ctx.effect 的 execute 在注册时立即执行（cordis 契约）；注册本身抛错
    //     时不会留下已递增、但永不 dispose 的计数；
    //   - 安装失败时由本 fiber 的 dispose 回收计数，不会残留无 owner 的包装。
    // Loader 行 reload 时新旧 entry 短暂并存：共享状态挂在 policy service 上，
    // 引用计数保证最后一个挂载点退出才还原官方 resolve。
    ctx.effect(() => merge.mount())
    // Config schema 只保证形状/默认值；这里仍是最终防线：canonical 化、危险根
    // 分级过滤、去重，非法 patch 值经 warn 可见（不静默忽略）。每次 apply 换新
    // 目录缓存与生效根，下一次 resolve 即用「当前这一代配置」。
    merge.update(normalizeRoots(cfg, warn), rootsFilter, warn)
    merge.install()
  } catch (error) {
    const reason = (error as Error)?.message ?? String(error)
    degraded = { reason }
    // 安全增强静默失效比初始化失败更危险：明确写出"extra roots are NOT in effect"。
    warn(`sandbox-extra-roots: init failed; extra writable roots are NOT in effect (the official sandbox policy is unchanged): ${reason}`)
  }

  // 设置页服务：独立 fail-safe——gateway 失败不影响 enforcement 包装；反之
  // enforcement 失败时 gateway 仍需注册（degraded 在卡片上可见）。
  try {
    ctx.plugin(PluginConfigGateway, { config: cfg, degraded })
  } catch (error) {
    ctx.logger?.warn?.(`sandbox-extra-roots: settings gateway failed (extra-root merging unaffected): ${(error as Error)?.message ?? String(error)}`)
  }
}
