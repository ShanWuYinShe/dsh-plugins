/**
 * runtime-sections.ts — 状态路由的两个响应段：探针结果与目录状态。
 *
 * 2026-10-08 从 360 行的 runtime.ts 拆出：这两个函数只读 VariantRuntime 的字段并整形，
 * 与 ctx / client / 生命周期无关；抽出来后可以脱离宿主直接喂一个 runtime 测试。
 *
 * @module dsh-any-connect/runtime-sections
 */

import type { WorkBuddyWebCatalog, WorkBuddyWebProbeSection } from './web-status.js'
import type { VariantRuntime } from './variant-runtime.js'
import { newestFirst } from './probe-store.js'

export function probeSection(runtime: VariantRuntime): WorkBuddyWebProbeSection {
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

export function catalogSection(runtime: VariantRuntime): WorkBuddyWebCatalog {
    return {
      source: runtime.catalogSource,
      ...runtime.catalogFetchedAtMs === undefined ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
      // 与 error 互斥：error 表示「没拉到、保留旧名单」，empty 表示「拉到了、就是空的」。
      ...runtime.catalogEmpty && runtime.catalogError === undefined ? { empty: true as const } : {},
      ...runtime.catalogError === undefined ? {} : { error: runtime.catalogError },
    }
  }
