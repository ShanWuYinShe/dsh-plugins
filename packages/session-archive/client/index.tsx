/**
 * index.tsx — 浏览器侧插件入口：注册侧边栏徽标与归档面板。
 *
 * 2026-10-29 适配 0.2.2：远程贡献不再手写（旧 REMOTE_CONTRIBUTION +
 * passthroughCodec 已删），改为消费官方 typert 生成器产出的 ./remote 工件
 * （package.json 的 "./remote" 子路径，由 src/remote.ts 的 @Remote 方法生成）。
 * 生成 d.ts 已对 TypertRemoteMap / TypertRemoteNamespaceMap 做声明合并，
 * 客户端类型不再需要第二套手写。
 *
 * 模块一览（改源码时请同步本表；根 test/ 的 module-map 回归会核对双向一致）：
 *
 * - index.tsx — 面板入口：注册侧边栏徽标与归档面板
 * - ArchivePanel.tsx ArchiveHeader.tsx ArchiveBadge.tsx ArchiveToolbar.tsx ArchiveDeleteAck.tsx
 *   ArchiveRow.tsx useArchivePanel.ts — 面板渲染（布局）、表头（标题/计数/刷新/关闭）、侧边栏
 *   徽标、工具栏（筛选/排序/批量）、删除确认条、列表行（勾选/详情）、状态与行为
 * - useArchiveList.ts useArchiveActions.ts useArchiveViewState.ts useArchivePanelChrome.ts
 *   useArchiveBadgeVisibility.ts useArchivePanelOpen.ts — 列表数据源、勾选/批量动作、视图偏好、
 *   对话框外壳行为（焦点/点击外部/Esc/Tab 陷阱）、徽标收起判定、开关状态与关闭动画
 * - archive-entries.ts archive-format.ts — 筛选/排序/导出/Markdown 与展示格式化
 * - styles.ts locales.ts — 样式注入与中英文案
 *
 * @module @chaoset/session-archive/client/index
 */

import archiveRemote from '@chaoset/session-archive/remote'
import { NS, zh, en } from './locales.js'
import { ArchivePanel } from './ArchivePanel.js'
// 样式注入是**模块加载副作用**：必须有人导入 styles.ts，否则面板渲染出来没有任何样式。
// 入口不转发 css（实现值不进公开面），测试直接从 './styles.js' 导入样式表。
import './styles.js'

export { apply, inject }

/** 归档 Remote 服务的五个方法（与 src/remote.ts 的 @Remote 集合一致；生成工件的调用端键）。 */
const REMOTE_METHODS = ["list", "count", "detail", "delete", "unarchive"] as const;
type RemoteMethod = (typeof REMOTE_METHODS)[number];

/** 客户端插件上下文（本插件用到的服务面；实现由宿主与其它客户端包提供）。 */
interface ClientContext {
  locale: {
    bind(ns: string): (key: string) => string;
    register(ns: string, dict: Record<string, Record<string, string>>): void;
  };
  effect(fn: () => void | (() => void), label?: string): void;
  remote: { $mount(contribution: unknown): Promise<void> };
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

/** ctx.remote.sessionArchive 的调用面（生成工件 ./remote 的调用端约定）。 */
type ArchiveRemoteService = Record<RemoteMethod, (...args: unknown[]) => Promise<RemoteResult<unknown>>>;

/** 宿主 workspaces 服务上的归档集合 store（徽标实时信号的来源）。 */
interface ArchivedStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { archivedSessionIds?: readonly string[] } | undefined;
}

/** 面板注入的远程调用函数：成功返回 value，失败抛结构化错误。 */
type ArchiveCall = <T>(method: RemoteMethod, ...args: unknown[]) => Promise<T>;

const inject = ["slots", "locale", "remote"];

// 与 dsh-any-connect / provider-usage 同一条兜底边界：slot API 破坏时
// 降级为 console.error（侧边栏少一个徽标），不得把异常抛给宿主 loader
// 炸出整页红条——纯 additive 的面板没有资格打断宿主。
async function apply(ctx: ClientContext) {
  try {
  ctx.effect(() => {
    try {
      ctx.locale.register(NS, { zh, en });
    } catch (error) {
      // 重复注册(HMR/热切换下宿主已持有同 ns 字典)静默忽略,其余失败只
      // 告警——面板文案回退到宿主默认,异常不得穿透 effect 阻断插件激活。
      const message = String((error as Error)?.message ?? error);
      if (!message.includes("already")) console.warn("session-archive: locale dictionary registration failed: " + message);
    }
  }, "session-archive: dictionaries");
  // 贡献体来自生成工件（描述符与 codec 由官方生成器产出），本文件不再手写。
  await ctx.remote.$mount(archiveRemote);
  const archiveService = ctx.get("remote.sessionArchive") as ArchiveRemoteService | undefined;
  if (archiveService === void 0) throw new Error("session-archive: remote.sessionArchive did not materialize after mount");
  const call: ArchiveCall = async <T,>(method: RemoteMethod, ...args: unknown[]): Promise<T> => {
    const result = await archiveService[method](...args);
    if (!result.ok) throw new Error(method + " failed: " + result.error.code + ": " + result.error.message);
    return result.value as T;
  };
  // 宿主 workspaces 服务的归档集合 store（实时信号的来源）：归档/恢复/
  // 宿主推送都会经过 installArchived 触发 store 通知。用 ctx.get 而非
  // inject——服务缺失时插件照常激活，面板退回 5s 轮询，不因等待挂起。
  const workspaces = ctx.get("workspaces") as { list?: ArchivedStore } | undefined;
  const archivedStore: ArchivedStore | undefined = workspaces?.list !== void 0
    && typeof workspaces.list.subscribe === "function"
    && typeof workspaces.list.getSnapshot === "function"
    ? workspaces.list
    : void 0;
  // 客户端 sessions 服务（会话摘要 byId 的持有者）：删除/恢复后主动刷新，
  // 让原生"设置 → 已归档会话"页立刻丢弃已彻底删除的 cold 条目。**必须惰性
  // 解析**——插件 apply 早于 sessions 服务挂载（实测同一页面多次加载中
  // ctx.get("sessions") 有 undefined 的时序），此刻取值为 undefined 会让
  // 刷新能力永久缺失。惰性 getter 在首次真正调用时（用户点删除）再解析。
  const refreshSessions = (): Promise<void> | undefined => {
    const sessions = ctx.get("sessions") as { refresh?: () => Promise<void> } | undefined;
    if (sessions === void 0 || typeof sessions.refresh !== "function") return;
    return sessions.refresh();
  };
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "session-archive",
    order: 20,
    locale: NS,
    inject: () => ({
      call,
      refreshSessions,
      subscribeArchived: archivedStore !== void 0 ? (fn: () => void) => archivedStore.subscribe(fn) : void 0,
      archivedCountOf: archivedStore !== void 0 ? () => {
        const snapshot = archivedStore.getSnapshot();
        return Array.isArray(snapshot?.archivedSessionIds) ? snapshot.archivedSessionIds.length : -1;
      } : void 0,
    })
  }, ArchivePanel));
  } catch (error: unknown) {
    console.error("[session-archive] client panel failed to load (sidebar badge missing):", error);
  }
}
