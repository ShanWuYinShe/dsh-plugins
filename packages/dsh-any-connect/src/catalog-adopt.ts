/**
 * catalog-adopt.ts — 账号切换时的目录采用（先发布已知最好目录，再由 live 改写）。
 *
 * 2026-10-08 从 339 行的 catalog-refresh.ts 拆出：这段是 refreshCatalog 里最长的一段内联逻辑
 * （38 行），只依赖 runtime 与「发布」回调；抽出来后 refreshCatalog 只剩「取凭据 → 采用身份 →
 * 拉取 → 落盘」的主干。
 *
 * @module dsh-any-connect/catalog-adopt
 */

import type { VariantRuntime } from './variant-runtime.js'
import { fallbackFor, variantIsStartPlan } from './variant-runtime.js'
import { filterByCodingPlanWhitelist } from './zcode-builtin-catalog.js'
import type { ZCodeUpstreamClient } from './upstream-zcode.js'

/** 账号真的换了（不是首次采用）时采用该账号最好的已知目录，并立即发布。 */
export function adoptIdentity(
  runtime: VariantRuntime,
  identity: string,
  publish: (runtime: VariantRuntime) => void,
): void {
  // 账号真的换了（不是首次采用）：旧账号的探针记录不能留给新账号。
  // 首次登录不清除——那会删掉该账号自己在重启前写入的记录。
  if (runtime.lastIdentity !== undefined) runtime.probeStore!.clear()
  runtime.lastIdentity = identity
  // 该账号最好的已知目录：上次成功拉取的 saved 优先于编译期 fallback。
  // saved 是"这个账号实际被服务过"的名单，比一次性快照更可信；这同时
  // 覆盖重启场景——重启后 saved 正是阻止分组落回内置名单的东西。
  const saved = runtime.catalogStore!.saved(identity)
  if (saved !== undefined) {
    // saved 可能由**旧版本**写入（那时还没有产品面白名单），启动时会先于
    // live 拉取发布——实测 2026-10-08：升级用户的 saved 里躺着 11 个
    // Coding Plan 模型，而客户端只提供 2 个，用户会先看到一整屏越界模型。
    // 这里用与 live 同一份白名单过滤；白名单不可得则原样发布（宁可按
    // saved 展示，也不因读不到客户端文件而抹掉整组）。Start Plan 不走
    // 这条：它的 saved 是 entitlements 派生的名单，语义不同。
    const savedModels = runtime.variant.kind === 'zcode' && !variantIsStartPlan(runtime.variant)
      ? filterByCodingPlanWhitelist(saved.models, (runtime.client as ZCodeUpstreamClient | undefined)?.codingPlanWhitelist?.())
      : saved.models
    runtime.catalog.set([...savedModels])
    runtime.catalogSource = 'saved'
    runtime.catalogFetchedAtMs = saved.fetchedAtMs
  } else {
    runtime.catalog.set(fallbackFor(runtime.variant))
    runtime.catalogSource = 'fallback'
    runtime.catalogFetchedAtMs = undefined
  }
  runtime.catalogError = undefined
  // 这一拍是 saved/fallback 先行发布，不是上游的答案：空名单说明只对
  // 「live 拉取成功但零模型」成立，随后那次 live 会自己改写它。
  runtime.catalogEmpty = false
  runtime.catalog.setVisible(true)
  publish(runtime)
  // saved/fallback 目录先行发布时同样补齐缺失检测：行与旧目录不同
  // 的候选（fingerprint 失效）在这里入队；随后 live 拉取成功会再触
  // 发一次，pending 去重保证同一模型不重复跑。
  runtime.probeService?.probeMissingCandidates()
}
