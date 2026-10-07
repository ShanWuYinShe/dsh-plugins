/**
 * index.tsx — 浏览器侧插件入口：注册侧边栏徽标与归档面板。
 *
 * 2026-10-08 从 1194 行的 client/index.tsx 拆出：样式、文案、纯逻辑与面板组件
 * 各自成模块，入口只保留注册与 re-export。
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

import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { NS, zh, en } from './locales.js'
import { ArchivePanel } from './ArchivePanel.js'

export { filterArchived, ARCHIVE_SORT_KEYS, sortArchived, exportFilename, detailToMarkdown, mergeArchivedMarkdown, trapTarget, needsDeleteAck, DELETE_ACK_THRESHOLD, ARCHIVE_PAGE_SIZE } from './archive-entries.js'
export type { ArchiveSortKey } from './archive-entries.js'
export { css } from './styles.js'
export { apply, inject }

const inject = ["slots", "locale", "remote"];

const passthroughSchema = { parse: (value: any) => value };

const REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: "@chaoset/session-archive",
  descriptors: [
    { id: "@chaoset/session-archive#sessionArchive/list", service: "sessionArchive", namespace: "sessionArchive", method: "list", invocation: { kind: "direct" }, parameters: [], result: { mode: "strict", typeSymbol: "sessionArchive/list:result", create: () => passthroughSchema } },
    { id: "@chaoset/session-archive#sessionArchive/count", service: "sessionArchive", namespace: "sessionArchive", method: "count", invocation: { kind: "direct" }, parameters: [], result: { mode: "strict", typeSymbol: "sessionArchive/count:result", create: () => passthroughSchema } },
    { id: "@chaoset/session-archive#sessionArchive/detail", service: "sessionArchive", namespace: "sessionArchive", method: "detail", invocation: { kind: "direct" }, parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: { mode: "strict", typeSymbol: "sessionArchive/detail:sessionId", create: () => passthroughSchema } }], result: { mode: "strict", typeSymbol: "sessionArchive/detail:result", create: () => passthroughSchema } },
    { id: "@chaoset/session-archive#sessionArchive/delete", service: "sessionArchive", namespace: "sessionArchive", method: "delete", invocation: { kind: "direct" }, parameters: [{ name: "sessionIds", wire: "sessionIds", source: "json", codec: { mode: "strict", typeSymbol: "sessionArchive/delete:sessionIds", create: () => passthroughSchema } }], result: { mode: "strict", typeSymbol: "sessionArchive/delete:result", create: () => passthroughSchema } },
    { id: "@chaoset/session-archive#sessionArchive/unarchive", service: "sessionArchive", namespace: "sessionArchive", method: "unarchive", invocation: { kind: "direct" }, parameters: [{ name: "sessionIds", wire: "sessionIds", source: "json", codec: { mode: "strict", typeSymbol: "sessionArchive/unarchive:sessionIds", create: () => passthroughSchema } }], result: { mode: "strict", typeSymbol: "sessionArchive/unarchive:result", create: () => passthroughSchema } }
  ]
};
// 与 dsh-any-connect / provider-usage 同一条兜底边界：slot API 破坏时
// 降级为 console.error（侧边栏少一个徽标），不得把异常抛给宿主 loader
// 炸出整页红条——纯 additive 的面板没有资格打断宿主。

async function apply(ctx: any) {
  try {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => {
    try {
      ctx.locale.register(NS, { zh, en });
    } catch (error) {
      // 重复注册(HMR/热切换下宿主已持有同 ns 字典)静默忽略,其余失败只
      // 告警——面板文案回退到宿主默认,异常不得穿透 effect 阻断插件激活。
      const message = String((error as any)?.message ?? error);
      if (!message.includes("already")) console.warn("session-archive: locale dictionary registration failed: " + message);
    }
  }, "session-archive: dictionaries");
  await ctx.remote.$mount(REMOTE_CONTRIBUTION);
  const archiveService = ctx.get("remote.sessionArchive");
  if (archiveService === void 0) throw new Error("session-archive: remote.sessionArchive did not materialize after mount");
  const call = (method: any, ...args: any[]) => archiveService[method](...args).then((result: any) => {
    if (!result.ok) throw new Error(method + " failed: " + result.error.code + ": " + result.error.message);
    return result.value;
  });
  // 宿主 workspaces 服务的归档集合 store（实时信号的来源）：归档/恢复/
  // 宿主推送都会经过 installArchived 触发 store 通知。用 ctx.get 而非
  // inject——服务缺失时插件照常激活，面板退回 5s 轮询，不因等待挂起。
  const workspaces = ctx.get("workspaces");
  const archivedStore = workspaces !== null && typeof workspaces === "object"
    && workspaces.list !== void 0
    && typeof workspaces.list.subscribe === "function"
    && typeof workspaces.list.getSnapshot === "function"
    ? workspaces.list
    : void 0;
  // 客户端 sessions 服务（会话摘要 byId 的持有者）：删除/恢复后主动刷新，
  // 让原生"设置 → 已归档会话"页立刻丢弃已彻底删除的 cold 条目。**必须惰性
  // 解析**——插件 apply 早于 sessions 服务挂载（实测同一页面多次加载中
  // ctx.get("sessions") 有 undefined 的时序），此刻取值为 undefined 会让
  // 刷新能力永久缺失。惰性 getter 在首次真正调用时（用户点删除）再解析。
  const refreshSessions = () => {
    const sessions = ctx.get("sessions");
    if (sessions === null || typeof sessions !== "object" || typeof sessions.refresh !== "function") return;
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
      subscribeArchived: archivedStore !== void 0 ? (fn: any) => archivedStore.subscribe(fn) : void 0,
      archivedCountOf: archivedStore !== void 0 ? () => {
        const snapshot = archivedStore.getSnapshot();
        return Array.isArray(snapshot?.archivedSessionIds) ? snapshot.archivedSessionIds.length : -1;
      } : void 0,
    })
  }, ArchivePanel));
  } catch (error: any) {
    console.error("[session-archive] client panel failed to load (sidebar badge missing):", error);
  }
}
