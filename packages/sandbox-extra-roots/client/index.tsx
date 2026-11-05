/**
 * index.tsx — 浏览器侧入口：注册设置卡片与 typert 远程贡献。
 *
 * 2026-10-29 适配 0.2.2：远程贡献不再手写（旧 REMOTE_CONTRIBUTION +
 * passthroughCodec 已删），改为消费官方 typert 生成器产出的 ./remote 工件
 * （package.json 的 "./remote" 子路径，由 src/remote.ts 的 @Remote 方法生成）。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.tsx — 入口：apply/inject 与 typert 远程贡献挂载
 * - SandboxRootsCard.tsx — 设置卡片（表单 + 预览 + 保存）
 * - roots-preview.ts — 危险根预览（平台近似、词法前缀、预设、逐行分析）
 * - styles.ts locales.ts — 样式注入与中英文案
 *
 * @module sandbox-extra-roots-client
 */

import remoteContribution from '@chaoset/sandbox-extra-roots/remote'
// 样式注入是**模块加载副作用**：必须有人导入 styles.ts，否则卡片渲染出来没有任何样式。
// 2026-10-08 拆分后一度漏掉这条导入（产物里既无样式也无注入代码，测试没覆盖到）。
import './styles.js'
import { NS, zh, en } from './locales.js'
import { SandboxRootsCard } from './SandboxRootsCard.js'
import type {
  SandboxExtraRootsGetResult,
  SandboxExtraRootsSetRequest,
  SandboxExtraRootsSetResult,
} from '../src/types.js'

/** 客户端插件上下文（本插件用到的服务面；实现由宿主与其它客户端包提供）。 */
interface ClientContext {
  locale: {
    bind(ns: string): (key: string) => string;
    register(ns: string, dict: Record<string, Record<string, string>>): () => void;
  };
  effect(fn: () => void | (() => void), label?: string): void;
  remote: { $mount(contribution: unknown): Promise<() => Promise<void>> };
  get(name: string): unknown;
  slots: {
    inject(slot: string, fn: () => void): void;
    register(descriptor: Record<string, unknown>, component: unknown): void;
  };
}

/** Remote 调用结果（生成工件的 RemoteResult 线形：成功取 value，失败带结构化错误）。 */
type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/** remote.sandboxExtraRootsConfig 服务面（生成工件 ./remote 的调用端约定）。 */
interface ConfigRemoteService {
  get(): Promise<RemoteResult<SandboxExtraRootsGetResult>>;
  set(partial: SandboxExtraRootsSetRequest): Promise<RemoteResult<SandboxExtraRootsSetResult>>;
}

/**
 * 把 Remote 失败归一化成用户可读文案（RULE-039：调用侧按 code 判别，不用
 * instanceof）。稳定的本插件失败码映射到 locales 文案；未知 code（宿主网关
 * 折叠错误或未来新增码）返回 undefined，由调用方回退技术文本，不吞诊断信息。
 */
function localizeRemoteFailure(failure: { code: string; message: string }, t: (key: string) => string): string | undefined {
  switch (failure.code) {
    case "sandbox-extra-roots/config-unavailable":
      return t("saveConfigUnavailable");
    case "sandbox-extra-roots/invalid-config":
      // 函数替换：{message} 里可能含用户输入的路径（$& 等替换序列不能生效）。
      return t("saveInvalidConfig").replace("{message}", () => failure.message);
    default:
      return undefined;
  }
}

// ── 插件 apply ───────────────────────────────────────────────────────
// DSH 客户端的 remote.<ns> 服务不会自动生成：客户端代码必须用
// ctx.remote.$mount(contribution) 显式挂载（官方 dsh-api-remotes 即如此）。
// 若只把 remote.sandboxExtraRootsConfig 写进 inject 而不挂载，命名空间
// 永远不存在，客户端插件会一直 pending，web boot 报 "did not activate"。
// 贡献体来自生成工件（描述符与 codec 由官方生成器产出），本文件不再手写。
const inject = ["slots", "locale", "remote"];
// 与 dsh-any-connect / provider-usage 同一条兜底边界：slot API 破坏时
// 降级为 console.error（设置页少一张卡片），不得把异常抛给宿主 loader
// 炸出整页红条——纯 additive 的配置卡没有资格打断宿主。
async function apply(ctx: ClientContext) {
  // $mount 返回的卸载钩子归调用方所有：gateway 把挂载注册在自身 ctx 上，不会随本插件
  // fiber 回收。丢弃它会让「禁用→启用」或客户端热重载后的第二次挂载命中 already mounted，
  // 设置卡片随之消失（须刷新页面恢复）。成功时把它作为 apply 的 disposer 交回 cordis，
  // 失败降级时在这里自行卸载。
  const mounted: Array<() => Promise<void>> = [];
  const unmountRemote = async () => {
    await Promise.allSettled(mounted.splice(0).map((unmount) => unmount()));
  };
  try {
  // register 返回 disposer：必须交回 ctx.effect，卸载/HMR 后字典才会被回收、
  // 重载后的新字典才能替换旧文案（旧实现丢弃返回值并吞掉 "already" 重复注册
  // 错误，上版字典会一直生效）。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "sandbox-extra-roots: dictionaries");
  // 文案函数与 slot 注入的 t 同源（按当前语言在调用时解析）。
  const t = ctx.locale.bind(NS);
  // 先挂载命名空间，再用 ctx.get 取回服务：cordis 的属性访问（ctx.remote.X）
  // 要求 X 出现在 inject 里，而本插件的命名空间由自己挂载，若写进 inject
  // 会和自己等待的服务形成死锁，因此用 ctx.get（对未声明的服务合法）。
  mounted.push(await ctx.remote.$mount(remoteContribution));
  const configService = ctx.get("remote.sandboxExtraRootsConfig") as ConfigRemoteService | undefined;
  if (configService === void 0) throw new Error("sandbox-extra-roots: remote.sandboxExtraRootsConfig did not materialize after mount");
  const getConfig = () => configService.get().then((result) => {
    if (!result.ok) throw new Error("sandboxExtraRootsConfig.get failed: " + result.error.code + ": " + result.error.message);
    // 返回整个 get 结果（config + 可选 degraded）：enforcement 未生效时
    // 卡片必须能显示原因（SB-12），不能只取 config 把降级状态吞掉。
    return result.value;
  });
  const setConfig = (partial: SandboxExtraRootsSetRequest) => configService.set(partial).then((result) => {
    if (!result.ok) {
      // 已知 code → 本地化文案（卡片再包一层 t("saveFailed")）；未知 code →
      // 保留 code + 技术文本，便于诊断宿主网关折叠错误或新版本新增码。
      const localized = localizeRemoteFailure(result.error, t);
      throw new Error(localized ?? "sandboxExtraRootsConfig.set failed: " + result.error.code + ": " + result.error.message);
    }
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
  return unmountRemote;
  } catch (error: unknown) {
    await unmountRemote();
    console.error("[sandbox-extra-roots] client card failed to load (settings card missing):", error);
  }
}

export { apply, inject };
