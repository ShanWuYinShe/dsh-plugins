/**
 * index.tsx — 浏览器侧入口：注册设置卡片与 typert 远程贡献。
 *
 * 2026-10-08 从 425 行的单体 client/index.tsx 拆出：样式、预览纯函数、文案、卡片
 * 各自成模块，入口只保留 apply/inject、远程贡献与 re-export。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.tsx — 入口：apply/inject、typert 远程贡献与 re-export
 * - SandboxRootsCard.tsx — 设置卡片（表单 + 预览 + 保存）
 * - roots-preview.ts — 危险根预览（平台近似、词法前缀、预设、逐行分析）
 * - styles.ts locales.ts — 样式注入与中英文案
 *
 * @module sandbox-extra-roots-client
 */

import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { analyzeRootsText, hasBlockingProblems, presetsForPlatform, appendRootLine } from './roots-preview.js'
import { NS, zh, en } from './locales.js'
import { SandboxRootsCard } from './SandboxRootsCard.js'

// ── 插件 apply ───────────────────────────────────────────────────────
// DSH 客户端的 remote.<ns> 服务不会自动生成：必须由客户端代码用
// ctx.remote.$mount(contribution) 显式挂载（官方 dsh-api-remotes 即如此）。
// 若只把 remote.sandboxExtraRootsConfig 写进 inject 而不挂载，命名空间
// 永远不存在，客户端插件会一直 pending，web boot 报 "did not activate"。
// 因此本插件先挂载自己的命名空间，再注册设置卡片。
const inject = ["slots", "locale", "remote"];
const passthroughSchema = { parse: (value: any) => value };
const REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: "@chaoset/sandbox-extra-roots",
  descriptors: [
    {
      id: "@chaoset/sandbox-extra-roots#sandboxExtraRootsConfig/get",
      service: "sandboxExtraRootsConfig",
      namespace: "sandboxExtraRootsConfig",
      method: "get",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/get:result", create: () => passthroughSchema }
    },
    {
      id: "@chaoset/sandbox-extra-roots#sandboxExtraRootsConfig/set",
      service: "sandboxExtraRootsConfig",
      namespace: "sandboxExtraRootsConfig",
      method: "set",
      invocation: { kind: "direct" },
      parameters: [{
        name: "partial",
        wire: "partial",
        source: "json",
        codec: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/set:partial", create: () => passthroughSchema }
      }],
      result: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/set:result", create: () => passthroughSchema }
    }
  ]
};
// 与 dsh-any-connect / provider-usage 同一条兜底边界：slot API 破坏时
// 降级为 console.error（设置页少一张卡片），不得把异常抛给宿主 loader
// 炸出整页红条——纯 additive 的配置卡没有资格打断宿主。
async function apply(ctx: any) {
  try {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => {
    try {
      ctx.locale.register(NS, { zh, en });
    } catch (error) {
      // 重复注册(HMR/热切换下宿主已持有同 ns 字典)静默忽略,
      // 其余失败只告警——卡片文案回退到宿主默认,不阻断插件激活。
      const message = String((error as any)?.message ?? error);
      if (!message.includes("already")) console.warn("sandbox-extra-roots: locale dictionary registration failed: " + message);
    }
  }, "sandbox-extra-roots: dictionaries");
  // 先挂载命名空间，再用 ctx.get 取回服务：cordis 的属性访问（ctx.remote.X）
  // 要求 X 出现在 inject 里，而本插件的命名空间由自己挂载，若写进 inject
  // 会和自己等待的服务形成死锁，因此用 ctx.get（对未声明的服务合法）。
  await ctx.remote.$mount(REMOTE_CONTRIBUTION);
  const configService = ctx.get("remote.sandboxExtraRootsConfig");
  if (configService === void 0) throw new Error("sandbox-extra-roots: remote.sandboxExtraRootsConfig did not materialize after mount");
  const getConfig = () => configService.get().then((result: any) => {
    if (!result.ok) throw new Error(`sandboxExtraRootsConfig.get failed: ${result.error.code}: ${result.error.message}`);
    return result.value.config;
  });
  const setConfig = (partial: any) => configService.set(partial).then((result: any) => {
    if (!result.ok) throw new Error(`sandboxExtraRootsConfig.set failed: ${result.error.code}: ${result.error.message}`);
    return result.value;
  });
  ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
    name: "plugins.bundle.config",
    // keyed slot：key 为 bundle 的 npm 包名（plugins.bundle.config 契约，
    // 与 package.json "name" / cordis.patch.yml 的 name 一致），配置表单
    // 显示在本插件 Plugins 页（描述与 rows 之间）。
    key: "@chaoset/sandbox-extra-roots",
    locale: NS,
    inject: () => ({ getConfig, setConfig })
  }, SandboxRootsCard));
  } catch (error: any) {
    console.error("[sandbox-extra-roots] client card failed to load (settings card missing):", error);
  }
}

export { apply, inject, analyzeRootsText, hasBlockingProblems, appendRootLine, presetsForPlatform };
