import * as React from "react";
import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

// ── 样式（注入 style 标签，复用 DSH 设计变量）────────────────────────
var css = [
  // sa_root 是 footerActions（display:flex）的直接 flex 项（slot 出口为
  // display:contents 不参与布局）：不设宽度的话 flex 项收缩到内容宽，
  // 徽标的 width:calc(100% + 4px) 只等于内容宽，hover 高亮比「设置」
  // 入口窄一圈。显式撑满 + min-width:0，与 settingsArea 块级容器里的
  // 设置按钮获得同样的整行命中面积。
  ".sa_root{display:flex;min-width:0;width:100%}",
  // 徽标几何与官方侧边栏「设置」触发按钮（dsh-client-ui-settings-general
  // 的 .trigger / .rail）逐字对齐：同样的 calc(+4px) 宽度、42px 高、负外边距、
  // 非对称内边距、12px 圆角与同一 hover 变量——保证归档入口的 hover 命中
  // 面积与视觉节奏和设置入口完全一致（收起态同为 36×36 圆形）。
  ".sa_badge{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;transition:background-color .15s ease}",
  ".sa_badge:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".sa_badgeIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-primary)}",
  ".sa_badgeIcon svg{width:16px;height:16px;display:block}",
  ".sa_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
  ".sa_badgeCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}",
  ".sa_badge--collapsed{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}",
  ".sa_badge--collapsed .sa_badgeLabel,.sa_badge--collapsed .sa_badgeCount{display:none}",
  ".sa_badge--collapsed .sa_badgeIcon,.sa_badge--collapsed .sa_badgeIcon svg{width:18px;height:18px}",
  // 页面居中模态：z-index 30 高于侧边栏、低于宿主全局遮罩。
  ".sa_panel{z-index:30;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);width:640px;max-width:calc(100vw - 48px);max-height:min(72vh,calc(100vh - 96px));box-shadow:0 16px 48px rgba(0, 0, 0, 0.18), 0 4px 12px rgba(0, 0, 0, 0.10);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:14px;flex-direction:column;display:flex;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);overflow:hidden}",
  // 遮罩层：居中模态弹窗的视口级半透明底层，点击关闭面板。
  ".sa_overlay{position:fixed;inset:0;z-index:29;background:rgba(0,0,0,.25)}",
  // 入场动画：面板 150ms 淡入 + 轻微放大，遮罩 150ms 淡入。
  // 系统开启「减少动态效果」时完全禁用。
  "@media (prefers-reduced-motion:no-preference){.sa_panel{animation:sa-panel-in .15s ease-out}}",
  "@keyframes sa-panel-in{from{opacity:0;transform:translate(-50%,-50%) scale(.97)}}",
  "@media (prefers-reduced-motion:no-preference){.sa_overlay{animation:sa-overlay-in .15s ease-out}}",
  "@keyframes sa-overlay-in{from{opacity:0}}",
  ".sa_panel:focus{outline:none}",
  ".sa_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);flex:none;justify-content:space-between;align-items:center;min-height:48px;padding:10px 16px;display:flex}",
  ".sa_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}",
  ".sa_iconBtn{font:inherit;cursor:pointer;border:0;border-radius:8px;width:36px;height:36px;color:var(--dsw-alias-label-secondary,#666);background:0 0;display:inline-flex;align-items:center;justify-content:center;font-size:18px}",
  ".sa_refresh{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-height:36px;padding:5px 14px;font-size:13px;line-height:20px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:5px}",
  ".sa_refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
  ".sa_refresh:disabled{opacity:.4;cursor:default}",
  ".sa_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".sa_iconBtn:disabled{opacity:.4;cursor:default}",
  ".sa_toolbar{flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:8px 16px;display:flex;flex-wrap:wrap}",
  ".sa_filterInput{flex:1 1 100%;box-sizing:border-box;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
  ".sa_filterInput::placeholder{color:var(--dsw-alias-label-tertiary)}",
  ".sa_filterInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
  ".sa_check{accent-color:var(--dsw-alias-label-primary);width:14px;height:14px;flex:none;cursor:pointer}",
  ".sa_check:disabled{cursor:default;opacity:.45}",
  ".sa_toolLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;user-select:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px}",
  ".sa_count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:1}",
  ".sa_action{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 10px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);transition:all .15s ease}",
  ".sa_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}",
  ".sa_action:disabled{opacity:.4;cursor:default}",
  ".sa_actionDanger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}",
  ".sa_actionDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary)}",
  ".sa_actionDanger:disabled{opacity:.4}",
  ".sa_confirm{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}",
  ".sa_confirm:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:#fff}",
  ".sa_body{flex:1;min-height:0;padding:8px 16px 16px;overflow-y:auto}",
  ".sa_empty{color:var(--dsw-alias-label-tertiary);margin:24px 0;text-align:center;font-size:12px;line-height:18px}",
  ".sa_error{color:var(--dsw-alias-state-error-primary);margin:8px 0;font-size:12px;line-height:18px}",
  ".sa_ok{color:var(--dsw-alias-state-success-primary);margin:8px 0;font-size:12px;line-height:18px}",
  // 提示级通知（如「请先勾选会话」）不该与错误同色：用 warn 色区分严重度。
  ".sa_warn{color:var(--dsw-alias-state-warn-primary);margin:8px 0;font-size:12px;line-height:18px}",
  // 大批量删除确认条：错误色边框 + 浅红底（12% mix，与宿主 Tag danger 同口径）。
  ".sa_ack{border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-radius:12px;padding:10px 12px;margin:0 0 8px;flex-direction:column;gap:8px;display:flex}",
  ".sa_ackText{color:var(--dsw-alias-label-primary);margin:0;font-size:12px;line-height:18px}",
  ".sa_ackLabel{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;user-select:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px}",
  ".sa_ackActions{justify-content:flex-end;display:flex}",
  ".sa_rows{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}",
  ".sa_row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;flex-direction:column;gap:6px;padding:8px 10px;display:flex;transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}",
  ".sa_row:hover{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1);transform:translateY(-1px)}",
  ".sa_row .sa_check{opacity:.55;transition:opacity .15s ease}",
  ".sa_row:hover .sa_check{opacity:1}",
  ".sa_rowHead{align-items:center;gap:8px;display:flex}",
  ".sa_rowTitle{background:none;border:none;padding:0;text-align:left;font:inherit;min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;font-weight:500;line-height:20px;overflow:hidden;cursor:pointer}",
  ".sa_rowTitle:hover{text-decoration:underline}",
  ".sa_live{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);height:18px;border-radius:9px;flex:none;align-items:center;padding:0 6px;font-size:11px;line-height:18px;display:inline-flex}",
  ".sa_rowMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}",
  ".sa_rowMeta code{font-family:var(--ds-font-family-code,monospace)}",
  ".sa_rowFoot{justify-content:space-between;align-items:center;gap:8px;display:flex}",
  ".sa_rowActions{flex:none;align-items:center;gap:8px;display:flex}",
  ".sa_detail{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:8px;flex-direction:column;gap:10px;display:flex;max-height:260px;overflow-y:auto}",
  ".sa_msg{flex-direction:column;gap:2px;display:flex}",
  ".sa_msgRole{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;text-transform:uppercase;letter-spacing:.04em}",
  ".sa_msgText{color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:18px}",
  ".sa_msgTextUser{color:var(--dsw-alias-label-secondary)}",
  ".sa_msgBubble{max-width:85%;padding:8px 12px;border-radius:12px;font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}",
  ".sa_msgUser{align-self:flex-end;background:var(--dsw-alias-brand-primary,#1677ff);color:#fff;border-bottom-right-radius:4px}",
  ".sa_msgAssistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,0.04));color:var(--dsw-alias-label-primary);border-bottom-left-radius:4px}",
  ".sa_msgRoleChip{display:inline-block;font-size:10px;line-height:14px;padding:1px 6px;border-radius:4px;margin-bottom:2px}",
  ".sa_msgRoleUser{color:rgba(255,255,255,.7);align-self:flex-end}",
  ".sa_msgRoleAssistant{color:var(--dsw-alias-label-tertiary);align-self:flex-start}",
  ".sa_overlay--closing{opacity:0;transition:opacity .15s ease-out}",
  ".sa_panel--closing{opacity:0;transform:translate(-50%,-50%) scale(.97);transition:opacity .15s ease-out,transform .15s ease-out}",
  ".sa_busy{opacity:.55;pointer-events:none}",
  // 加载中：spinner + 文案（列表与详情共用）。系统开启「减少动态效果」时
  // spinner 停止旋转（保持静态圆环，提示语义仍在）。
  ".sa_loading{color:var(--dsw-alias-label-tertiary);margin:8px 0;font-size:12px;line-height:18px;display:flex;align-items:center;gap:6px}",
  ".sa_spin{flex:none;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:sa-spin .8s linear infinite}",
  "@keyframes sa-spin{to{transform:rotate(360deg)}}",
  "@media (prefers-reduced-motion:reduce){.sa_spin{animation:none}}"
].join("");
var tagId = "@chaoset/session-archive/client.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
  var tag = document.createElement("style");
  tag.dataset.plugin = "@chaoset/session-archive";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}

// ── 字典 ─────────────────────────────────────────────────────────────
const NS = "sidebar.sessionArchive";
const zh = {
  badge: "归档",
  panelTitle: "归档会话",
  refresh: "刷新",
  close: "关闭",
  empty: "暂无归档会话。在会话列表的更多菜单中归档会话后会出现在这里。",
  loadFailed: "加载归档列表失败",
  loading: "加载中…",
  selectAll: "全选",
  selected: "已选 {n} 项",
  restore: "恢复所选",
  restoreDone: "已恢复 {n} 个归档会话",
  restoreFailed: "恢复失败：{n} 个",
  delete: "删除所选",
  deleteConfirm: "再次点击确认删除",
  deleteDone: "已删除 {n} 个归档会话",
  deleteFailed: "删除失败：{n} 个",
  confirmAll: "确认删除全部 {n} 个？",
  joiner: "；",
  deleteConfirmBody: "将彻底删除 {n} 个归档会话，对应文件无法恢复。",
  deleteAcknowledge: "我确认删除这 {n} 个会话",
  cancel: "取消",
  showMore: "加载更多（剩余 {n} 个）",
  filterPlaceholder: "按标题、路径或 ID 筛选",
  sortBy_time: "排序：最近修改",
  sortBy_size: "排序：体积",
  sortBy_title: "排序：标题",
  sortByHint: "点击切换排序方式",
  noMatch: "没有匹配筛选条件的归档会话",
  noSelection: "请先勾选会话",
  view: "查看",
  collapse: "收起",
  live: "运行中",
  detailLoadFailed: "读取会话内容失败",
  noneTitle: "（无标题）",
  user: "用户",
  assistant: "助手",
  messages: "共 {n} 条消息",
  messagesTruncated: "共 {n} 条消息（已截断）",
  noMessages: "（无文本消息）",
  sizeBytes: "{n} B",
  sizeKB: "{n} KB",
  sizeMB: "{n} MB",
  runningHint: "该会话仍在生成落盘，请稍后重试",
  batchError: "批量操作失败（{n} 项）",
  reasonUnenumerable: "会话文件枚举不到",
  reasonUnlocatable: "无法定位会话文件",
  reasonReappeared: "删除后被重建",
  reasonNotArchived: "不是归档会话",
  reasonNotRestorable: "文件已不在，无法恢复",
  restartNeeded: "其中 {n} 个会话仍在内存中，设置 → 已归档会话的条目将在宿主重启后消失"
};
const en = {
  badge: "Archive",
  panelTitle: "Archived sessions",
  refresh: "Refresh",
  close: "Close",
  empty: "No archived sessions. Archive a session from its menu in the session list and it will show up here.",
  loadFailed: "Failed to load archive list",
  loading: "Loading…",
  selectAll: "Select all",
  selected: "{n} selected",
  restore: "Restore",
  restoreDone: "Restored {n} archived sessions",
  restoreFailed: "Restore failed: {n}",
  delete: "Delete",
  deleteConfirm: "Click again to confirm delete",
  deleteDone: "Deleted {n} archived sessions",
  deleteFailed: "Deletion failed: {n}",
  confirmAll: "Delete all {n}?",
  joiner: ";",
  deleteConfirmBody: "This will permanently delete {n} archived sessions; their files cannot be recovered.",
  deleteAcknowledge: "I confirm deleting these {n} sessions",
  cancel: "Cancel",
  showMore: "Show more ({n} remaining)",
  filterPlaceholder: "Filter by title, path, or id",
  sortBy_time: "Sort: recently modified",
  sortBy_size: "Sort: size",
  sortBy_title: "Sort: title",
  sortByHint: "Click to cycle sort order",
  noMatch: "No archived sessions match the filter",
  noSelection: "Select sessions first",
  view: "View",
  collapse: "Collapse",
  live: "Running",
  detailLoadFailed: "Failed to read session content",
  noneTitle: "(no title)",
  user: "User",
  assistant: "Assistant",
  messages: "{n} messages",
  messagesTruncated: "{n}+ messages",
  noMessages: "(no text messages)",
  sizeBytes: "{n} B",
  sizeKB: "{n} KB",
  sizeMB: "{n} MB",
  runningHint: "Session still writing; retry shortly",
  batchError: "Batch operation failed ({n})",
  reasonUnenumerable: "session log not enumerable",
  reasonUnlocatable: "session file cannot be located",
  reasonReappeared: "recreated after delete",
  reasonNotArchived: "not an archived session",
  reasonNotRestorable: "file no longer present",
  restartNeeded: "{n} still live in memory; their Settings → Archived sessions entries will disappear after the host restarts"
};

// ── 工具函数 ─────────────────────────────────────────────────────────
function formatBytes(bytes: any, t: any) {
  // 0/缺失(文件已不可 stat)显示占位符,避免误导性的 "0 B"。
  if (bytes === void 0 || bytes === null || Number(bytes) === 0) return "—";
  if (bytes < 1024) return t("sizeBytes").replace("{n}", String(bytes));
  if (bytes < 1024 * 1024) return t("sizeKB").replace("{n}", (bytes / 1024).toFixed(1));
  return t("sizeMB").replace("{n}", (bytes / (1024 * 1024)).toFixed(1));
}
function formatTime(ms: any) {
  // new Date(不可解析值) 不抛错而是返回 Invalid Date, toLocaleString 返回
  // 字符串 "Invalid Date"——catch 兜不住,须显式判 NaN 后回退原值。
  // host 端 detail 的 time 标注为 unknown,契约不保证可解析。
  try {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
  } catch { return String(ms); }
}
function shortId(id: any) {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}
// 列表浅比较(sessionId+updatedAt+size+live):数据没变就不 setItems,
// 静默刷新/重复刷新不再触发整表 reconcile。
function sameItems(a: any[], b: any[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x === void 0 || y === void 0) return false;
    if (x.sessionId !== y.sessionId || x.updatedAt !== y.updatedAt || x.size !== y.size || x.live !== y.live) return false;
  }
  return true;
}

// 焦点陷阱的按键判定（纯函数，可单测）：面板内有序可聚焦元素 + 当前
// activeElement，返回 Tab / Shift+Tab 应跳往的元素；不需要环绕返回 undefined。
// 行为抄宿主 Modal（只抄行为，不引用其实现——官方插件开发 skill 明令
// 第三方插件不得 require 宿主 client 包）。
/** 归档筛选：子串不区分大小写匹配标题/工作区路径/会话 ID；空查询返回
 * 副本。纯函数导出供单测（client-filter.test.ts）与面板 useMemo 共用——
 * 筛选语义改动时测试即红。 */
export function filterArchived<T extends { title: unknown; cwd: unknown; sessionId: unknown }>(
  items: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((item) =>
    String(item.title ?? "").toLowerCase().includes(q)
      || String(item.cwd ?? "").toLowerCase().includes(q)
      || String(item.sessionId ?? "").toLowerCase().includes(q));
}

/** 归档排序键。time=最近修改在前；size=体积大在前；title=标题字典序
 * （不区分大小写，无标题行排最后）。 */
export type ArchiveSortKey = "time" | "size" | "title";
export const ARCHIVE_SORT_KEYS: readonly ArchiveSortKey[] = ["time", "size", "title"];

/** 排序纯函数（不改动入参），导出供单测（client-sort.test.ts）与面板
 * useMemo 共用。与 filterArchived 组合：先筛后排。 */
export function sortArchived<T extends { updatedAt: unknown; size: unknown; title: unknown }>(
  items: readonly T[],
  key: ArchiveSortKey,
): T[] {
  const out = [...items];
  if (key === "time") out.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
  else if (key === "size") out.sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0));
  else out.sort((a, b) => {
    // 用小写后的 < > 比较(UTF-16 码元序,跨环境确定)而非 localeCompare:
    // 后者的排序位置依赖宿主 ICU/locale,CI 与本机顺序可能不同——排序
    // 测试需要确定结果。非 ASCII 标题在同语言内部仍保持稳定相对顺序。
    const ta = String(a.title ?? "").toLowerCase();
    const tb = String(b.title ?? "").toLowerCase();
    if (ta === "" && tb !== "") return 1; // 无标题行排最后
    if (tb === "" && ta !== "") return -1;
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });
  return out;
}

function trapTarget(focusables: any[], active: any, shift: boolean): any | undefined {
  if (focusables.length === 0) return undefined;
  if (shift && active === focusables[0]) return focusables[focusables.length - 1];
  if (!shift && active === focusables[focusables.length - 1]) return focusables[0];
  return undefined;
}

// 大批量彻底删除的二次确认阈值：达到该数量的删除不再允许“同按钮双击
// 穿透”，必须经下面的 needsDeleteAck 闸（勾选确认框后才可点——抄宿主
// RiskConfirmation 的行为，不引用其实现）。
const DELETE_ACK_THRESHOLD = 5;
// 归档列表分页步长：全量渲染几百行会卡，默认只渲第一页，“加载更多”追加。
const ARCHIVE_PAGE_SIZE = 50;
function needsDeleteAck(selectedSize: number, confirming: boolean): boolean {
  return confirming && selectedSize >= DELETE_ACK_THRESHOLD;
}

// ── 归档面板 ─────────────────────────────────────────────────────────
function ArchivePanel(props: any) {
  const t = props.t;
  const call = props.call;
  // 侧边栏收起（icon rail）时，DSH 通过 wide=false 告知（侧边栏 footer 注入点
  // 下发的是 wide，而非 collapsed）。以 wide 为准；仅当宿主未下发 wide 时，才用
  // ResizeObserver 观察所在格宽度（<80px 视为收起）兜底，避免窄格把文字标签挤变形。
  const wideExplicit = typeof props.wide === "boolean" ? props.wide : void 0;
  const [narrow, setNarrow] = React.useState(false);
  const collapsed = wideExplicit === void 0 ? narrow : !wideExplicit;
  const badgeRef = React.useRef<any>(null);
  React.useEffect(() => {
    const el = badgeRef.current?.parentElement;
    if (el === undefined || el === null || typeof (globalThis as any).ResizeObserver === "undefined") return;
    const ro = new (globalThis as any).ResizeObserver((entries: any[]) => {
      for (const entry of entries) {
        const w = entry.contentRect?.width ?? el.clientWidth;
        setNarrow(w > 0 && w < 80);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 有显式 wide 时完全以宿主状态为准，避免 ResizeObserver 的窄格判断在
  // 展开后仍残留，导致展开态误用 collapsed 样式（图标不居中、文字丢失）。
  const iconOnly = collapsed;
  const rootRef = React.useRef<any>(null);
  const [open, setOpen] = React.useState(false);
  const [closing, setClosing] = React.useState(false);

  // 关闭动画的 timer 存句柄:动画进行中点徽标应是「取消关闭、重新打开」,
  // 否则 open 仍为 true 期间的那次点击会被当成再次关闭吞掉,用户需要点
  // 两次才能重开;卸载后也不再触发无意义的回调。
  const closeTimerRef = React.useRef<any>(0);
  const closePanel = React.useCallback(() => {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOpen(false);
      setClosing(false);
    } else {
      setClosing(true);
      globalThis.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = globalThis.setTimeout(() => {
        setOpen(false);
        setClosing(false);
      }, 150);
    }
  }, []);
  const reopenPanel = React.useCallback(() => {
    globalThis.clearTimeout(closeTimerRef.current);
    setClosing(false);
    setOpen(true);
  }, []);
  // 卸载时取消挂着的关闭动画回调(声明与实现一致;React 下 setState 为 no-op,
  // 但清理让卸载后的行为完全确定)。
  React.useEffect(() => () => globalThis.clearTimeout(closeTimerRef.current), []);

  const [items, setItems] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<any>(null);
  const [selected, setSelected] = React.useState<Set<any>>(new Set());
  const [expanded, setExpanded] = React.useState<any>(null);
  const [details, setDetails] = React.useState<Map<any, any>>(new Map());
  const [detailLoading, setDetailLoading] = React.useState<Set<any>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  // 大批量删除的勾选确认（抄宿主 RiskConfirmation“先勾选后可点”的行为）：
  // 确认态解除时由下面的 effect 统一复位，各处不再逐个补。
  const [deleteAcked, setDeleteAcked] = React.useState(false);
  React.useEffect(() => {
    if (!confirmingDelete) setDeleteAcked(false);
  }, [confirmingDelete]);
  const [notice, setNotice] = React.useState<any>(null);
  // 关闭态徽标计数（由 count() 轻端点轮询维护；列表落地时也会同步）。
  const [badgeCount, setBadgeCount] = React.useState(0);
  // 列表分页：只渲前 visibleCount 行；打开/手动刷新回到第一页，
  // 静默刷新不碰（不打断用户已展开的“更多”）。
  const [visibleCount, setVisibleCount] = React.useState(ARCHIVE_PAGE_SIZE);

  // 列表落地（加载与静默刷新共用）：sameItems 比较避免无变化时整表
  // reconcile；同时剔除已消失 id 的残留勾选——否则"已选 N 项"虚高，
  // 还可能把幽灵 id 发给批量操作（host 有幂等兜底，但不该依赖它）。
  // 顺手用列表长度同步徽标计数：count() 端点不可用（host 旧进程未重启、
  // RPC 失败被吞）时，开/关一次面板徽标也能自我纠正，不会卡在 0。
  const applyItems = React.useCallback((next: any[]) => {
    setItems((current) => (sameItems(current, next) ? current : next));
    setBadgeCount(next.length);
    const nextIds = new Set(next.map((item: any) => item.sessionId));
    setSelected((currentSelected) => {
      const pruned = [...currentSelected].filter((id) => nextIds.has(id));
      return pruned.length === currentSelected.size ? currentSelected : new Set(pruned);
    });
  }, []);
  // list 请求纪元:打开态有三条并发 list 来源(30s tick、订阅事件、批量
  // 操作的收尾 load),乱序落地时后到的旧响应会把刚删除/恢复的行「复活」
  // 并连同过期徽标计数写回,直到下一轮刷新才自愈。落地前必须确认自己是
  // 最新一次请求。
  const listSeqRef = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++listSeqRef.current;
    setLoading(true);
    setError(null);
    setVisibleCount(ARCHIVE_PAGE_SIZE);
    try {
      const result = await call("list");
      if (seq !== listSeqRef.current) return;
      applyItems(Array.isArray(result.items) ? result.items : []);
    } catch (loadError: any) {
      if (seq !== listSeqRef.current) return;
      setError(t("loadFailed") + ": " + (loadError && loadError.message || loadError));
    } finally {
      // 纪元守卫:旧 load 迟到时不得提前关掉更新的、仍在途的 load 的 spinner。
      if (seq === listSeqRef.current) setLoading(false);
    }
  }, [call, applyItems, t]);
  // 打开态的静默刷新：不碰 loading，长开面板的列表不再陈旧；
  // sameItems 比较保证数据没变时不触发任何重渲染，不打断勾选。
  // 成功时顺带清掉旧的加载失败提示（error 一旦出现,静默刷新成功
  // 也不清的话会长期挂在已填充的列表上方误导用户）。
  const silentList = React.useCallback(async () => {
    const seq = ++listSeqRef.current;
    try {
      const result = await call("list");
      if (seq !== listSeqRef.current) return;
      setError(null);
      applyItems(Array.isArray(result.items) ? result.items : []);
    } catch {}
  }, [call, applyItems]);

  React.useEffect(() => {
    if (open) { setNotice(null); load(); }
  }, [open, load]);

  // 后台静默刷新归档计数：侧边栏徽标要在「聊天列表里出现归档」时就同步显示数量，
  // 而不是等到打开弹窗才更新。面板打开时由上面的 load() 负责，这里只在关闭态轮询，
  // 避免刷新打断用户在面板里的勾选/操作。关闭态走 count() 轻端点：list() 要解析
  // 每个归档会话的完整事件流,5 秒一次的徽标轮询用它是持续的性能债。
  // 标签页隐藏时暂停 interval（隐藏页的轮询是纯浪费），恢复可见时立即刷一次并重启。
  const refreshSilently = React.useCallback(async () => {
    try {
      const result = await call("count");
      setBadgeCount(typeof result.count === "number" ? result.count : 0);
    } catch {
      // count() 不可用（host 进程旧于 lib、端点缺失等）：退回一次 list()，
      // applyItems 会同步徽标计数——宁可贵一点也不让徽标卡在过期值。
      try {
        const result = await call("list");
        applyItems(Array.isArray(result.items) ? result.items : []);
      } catch {}
    }
  }, [call, applyItems]);
  React.useEffect(() => {
    if (open) return;
    let id: any = 0;
    const start = () => { if (id === 0) id = globalThis.setInterval(refreshSilently, 5000); };
    const stop = () => { if (id !== 0) { globalThis.clearInterval(id); id = 0; } };
    const onVis = () => {
      if (document.visibilityState === "visible") { refreshSilently(); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") { refreshSilently(); start(); }
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [open, refreshSilently]);

  // 打开态低频兜底刷新（30s）+ 恢复可见立即刷：面板长开时列表保持新鲜，
  // 且不与关闭态徽标轮询叠加。
  React.useEffect(() => {
    if (!open) return;
    const id = globalThis.setInterval(silentList, 30000);
    const onVis = () => { if (document.visibilityState === "visible") silentList(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { globalThis.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [open, silentList]);

  // 实时同步：订阅宿主 workspaces 服务的归档集合 store。用户在会话列表点
  // 「归档」、其它标签页变更、或宿主推送 host/archived-sessions-changed 时，
  // installArchived 都会触发 store 通知——这里立即重取 count（面板打开时
  // 顺带刷新列表），不必等 5 秒轮询。store 不可用时静默退回纯轮询。
  // 归档集合含 ghost id（已删除仍占位的记录），与 count() 的存在性过滤
  // 口径不同，因此只把集合变化当信号，数目仍以 count() 结果为准。
  const openRef = React.useRef(open);
  React.useEffect(() => { openRef.current = open; }, [open]);
  React.useEffect(() => {
    const subscribeArchived = props.subscribeArchived;
    const archivedCountOf = props.archivedCountOf;
    if (typeof subscribeArchived !== "function" || typeof archivedCountOf !== "function") return;
    let lastCount = archivedCountOf();
    const unsubscribe = subscribeArchived(() => {
      const n = archivedCountOf();
      if (typeof n !== "number" || n < 0 || n === lastCount) return;
      lastCount = n;
      refreshSilently();
      if (openRef.current) silentList();
    });
    return unsubscribe;
  }, [props.subscribeArchived, props.archivedCountOf, refreshSilently, silentList]);

  // 对话框焦点管理：打开时把焦点移入面板（键盘/读屏用户不必 Tab 瞎找），
  // 关闭时归还给徽标按钮；prevOpen 避免首次挂载（open=false）误触发归还。
  const panelRef = React.useRef<any>(null);
  const prevOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (open && !prevOpenRef.current) panelRef.current?.focus?.();
    else if (!open && prevOpenRef.current) badgeRef.current?.focus?.();
    prevOpenRef.current = open;
  }, [open]);

  // 提示（如「已恢复/已删除 N 个会话」）几秒后自动消失，避免残留误导用户，
  // 也避免删除全部归档后仍挂着上一条提示。
  React.useEffect(() => {
    if (notice === null) return;
    const id = globalThis.setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: any) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) {
        closePanel();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 面板按键（仅 open 时监听）：Esc 关闭是对话框惯例；Tab 环绕是焦点陷阱——
  // 面板声明了 aria-modal，Tab 不得跑到遮罩后的侧边栏元素上。
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: any) => {
      if (event.key === "Escape") {
        closePanel();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (panel === undefined || panel === null) return;
      const focusables = Array.from(panel.querySelectorAll(
        'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'
      ));
      const target = trapTarget(focusables, document.activeElement, event.shiftKey === true);
      if (target !== undefined) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 筛选:大归档量下逐页翻找效率低,标题/工作区路径/ID 子串前端过滤
  // (列表本就全量在内存,过滤纯展示层,不发请求)。
  // 筛选与排序持久化到 sessionStorage(标签页内跨页面重载保留):用户筛出
  // 一组会话后打开详情/误刷新,回来不必重新输入。禁用 sessionStorage 的
  // 环境(隐私模式)静默降级为不持久化。
  const FILTER_STORE_KEY = "sessionArchive.filter";
  const SORT_STORE_KEY = "sessionArchive.sort";
  const [filter, setFilterState] = React.useState(() => {
    try { return sessionStorage.getItem(FILTER_STORE_KEY) ?? ""; } catch { return ""; }
  });
  const setFilter = React.useCallback((value: string) => {
    setFilterState(value);
    try { sessionStorage.setItem(FILTER_STORE_KEY, value); } catch {}
  }, []);
  const [sortKey, setSortKeyState] = React.useState<ArchiveSortKey>(() => {
    try {
      const saved = sessionStorage.getItem(SORT_STORE_KEY);
      return (ARCHIVE_SORT_KEYS as readonly string[]).includes(saved ?? "") ? (saved as ArchiveSortKey) : "time";
    } catch { return "time"; }
  });
  const setSortKey = React.useCallback((next: ArchiveSortKey) => {
    setSortKeyState(next);
    try { sessionStorage.setItem(SORT_STORE_KEY, next); } catch {}
  }, []);
  const filteredItems = React.useMemo(() => filterArchived(items, filter), [items, filter]);
  // 先筛后排:排序在筛选结果上进行,「加载更多」分页按最终顺序切片。
  const sortedItems = React.useMemo(() => sortArchived(filteredItems, sortKey), [filteredItems, sortKey]);
  // 筛选变化回到第一页:否则 narrowed 结果落在已翻过的页码之外,看似空列表。
  React.useEffect(() => { setVisibleCount(ARCHIVE_PAGE_SIZE); }, [filter]);
  const visibleItems = sortedItems.slice(0, visibleCount);
  // 全选只作用于筛选结果:用户筛出一组会话后点全选,期望选中的是
  // 「看得见的这批」,而不是藏在筛选条件之外的全部。
  const selectable = sortedItems.filter((item) => !item.live);
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.sessionId));

  // 两段式删除 armed 态的 4 秒复位 timer：存 id，改勾选/执行/卸载时清掉，
  // 过期 timer 不得在 armed 已解除后再次写 false（方向虽安全，属卫生债）。
  const confirmTimer = React.useRef<any>(0);
  const disarmDelete = () => {
    if (confirmTimer.current !== 0) {
      globalThis.clearTimeout(confirmTimer.current);
      confirmTimer.current = 0;
    }
    setConfirmingDelete(false);
  };
  const toggleAll = (checked: any) => {
    if (checked) {
      setSelected(new Set(selectable.map((item) => item.sessionId)));
    } else {
      setSelected(new Set());
    }
    // 选择集变化即解除两段式删除的 armed 态:否则 4 秒窗口内改勾选,
    // 第二次点击会把确认"误嫁"给新的选择集。
    disarmDelete();
  };
  const toggleOne = (sessionId: any, checked: any) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
    disarmDelete();
  };

  const toggleDetail = (item: any) => {
    if (expanded === item.sessionId) {
      setExpanded(null);
      return;
    }
    setExpanded(item.sessionId);
    // 同一 id 的详情请求在途时不重复发（快速“查看→收起→查看”）：
    // last-write-wins 虽结果一致，但多一次完整事件流解析纯属浪费。
    // 展开态先给，在途请求落定后内容自动出现。
    if (detailLoading.has(item.sessionId)) return;
    const cached = details.get(item.sessionId);
    // 失败结果不缓存拦截:之前把 {error} 写进 Map 后 has() 恒真,唯一出路是
    // 刷新页面;现在再次点击即重新请求。
    if (cached === void 0 || cached.error !== void 0) {
      setDetailLoading((current) => new Set(current).add(item.sessionId));
      call("detail", item.sessionId).then((detail: any) => {
        setDetails((current) => new Map(current).set(item.sessionId, detail));
      }).catch((detailError: any) => {
        setDetails((current) => new Map(current).set(item.sessionId, {
          error: t("detailLoadFailed") + ": " + (detailError && detailError.message || detailError)
        }));
      }).finally(() => {
        setDetailLoading((current) => {
          const next = new Set(current);
          next.delete(item.sessionId);
          return next;
        });
      });
    }
  };

  const runBatch = async (action: any, doneKey: any, failKey: any) => {
    const ids = [...selected];
    if (ids.length === 0) {
      setNotice({ kind: "warn", text: t("noSelection") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await call(action, ids);
      const doneIds = result.deleted || result.restored || [];
      const n = doneIds.length;
      const doneText = t(doneKey).replace("{n}", String(n));
      // delete 成功但内存会话仍在的 id：原生"设置 → 已归档会话"页按归档集合
      // JOIN 会话摘要展示，ghost 保留 + 内存摘要仍在 → 该页在宿主重启前仍会
      // 显示这些条目。如实提示，不让用户以为删除没生效。
      const restartIds = Array.isArray(result.needsRestart) ? result.needsRestart : [];
      const restartText = restartIds.length > 0
        ? t("restartNeeded").replace("{n}", String(restartIds.length))
        : null;
      if (Array.isArray(result.failed) && result.failed.length > 0) {
        // host 对每个失败项都给了 reason( live/busy/unenumerable/not-archived
        // /not-restorable/具体错误),只报数量会让用户不知道为什么失败、该等
        // 多久重试。全部本地化,未知 reason 原样透出兜底。
        const reasonText = (reason: any) => {
          const map: Record<string, any> = {
            live: t("live"),
            busy: t("runningHint"),
            unenumerable: t("reasonUnenumerable"),
            unlocatable: t("reasonUnlocatable"),
            reappeared: t("reasonReappeared"),
            "not-archived": t("reasonNotArchived"),
            "not-restorable": t("reasonNotRestorable"),
          };
          return map[String(reason)] ?? String(reason ?? "error");
        };
        const detail = result.failed.slice(0, 3)
          .map((item: any) => shortId(item.sessionId) + ": " + reasonText(item.reason))
          .join("; ");
        const more = result.failed.length > 3 ? " (+" + (result.failed.length - 3) + ")" : "";
        const failText = t(failKey).replace("{n}", String(result.failed.length)) + " — " + detail + more;
        // 全失败才用 error 样式;部分成功是 warn,成功计数也要如实带上,
        // 不能只报失败让用户以为一个都没成。附带 needsRestart 时同样 warn。
        if (n > 0) setNotice({ kind: "warn", text: doneText + t("joiner") + " " + failText + (restartText !== null ? t("joiner") + " " + restartText : "") });
        else setNotice({ kind: "error", text: failText });
      } else if (restartText !== null) {
        setNotice({ kind: "warn", text: doneText + t("joiner") + " " + restartText });
      } else {
        setNotice({ kind: "ok", text: doneText });
      }
      if (doneIds.length > 0) {
        const done = new Set(doneIds);
        setItems((current) => current.filter((item) => !done.has(item.sessionId)));
        // 已删除会话的详情/展开态一并清掉：Map 残留会让内存缓慢增长，
        // 展开态残留则指向一个已不存在的行。
        setDetails((current: any) => {
          const next = new Map(current);
          for (const id of done) next.delete(id);
          return next.size === current.size ? current : next;
        });
        setExpanded((current: any) => (current !== null && done.has(current) ? null : current));
      }
      setSelected(new Set());
      disarmDelete();
      if (doneIds.length > 0 && typeof props.refreshSessions === "function") {
        // 删除/恢复后刷新客户端会话列表：原生"设置 → 已归档会话"页的每行是
        // 归档集合 ∩ 会话摘要（byId），cold 会话的文件已删但客户端 byId 缓存
        // 仍留着摘要，不刷新原生页会继续显示已彻底删除的条目。静默失败——本
        // 面板自身的 load() 已保证面板正确，不拿它挡提示。
        try { await props.refreshSessions(); } catch {}
      }
      await load();
    } catch (actionError: any) {
      // 异常分支(整单失败,不是部分失败):带请求发出时的数量,与部分失败分支措辞区分。
      setNotice({ kind: "error", text: t("batchError").replace("{n}", String(ids.length)) + ": " + (actionError && actionError.message || actionError) });
    } finally {
      setBusy(false);
    }
  };
  const restoreSelected = () => runBatch("unarchive", "restoreDone", "restoreFailed");
  const deleteSelected = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      if (confirmTimer.current !== 0) globalThis.clearTimeout(confirmTimer.current);
      confirmTimer.current = globalThis.setTimeout(() => {
        confirmTimer.current = 0;
        setConfirmingDelete(false);
      }, 4000);
      return;
    }
    // 大批量且未勾选确认框：第二次点击也不执行，等勾选（工具栏按钮同样
    // 禁用中，双保险防“双击节奏穿透”）。
    if (needsDeleteAck(selected.size, confirmingDelete) && !deleteAcked) return;
    runBatch("delete", "deleteDone", "deleteFailed");
  };

  const hasSelection = selected.size > 0;
  // 徽标的 accessible name：icon-only（侧边栏收起）时没有可见文本，
  // aria-label 必须自带语义与数量，不能只依赖 title。
  const shownCount = open ? items.length : badgeCount;
  const badgeTitle = t("badge") + (shownCount > 0 ? " (" + String(shownCount) + ")" : "");

  return React.createElement(
    "div",
    { className: "sa_root", ref: rootRef },
      React.createElement(
        "button",
        {
          ref: badgeRef,
          className: "sa_badge" + (iconOnly ? " sa_badge--collapsed" : ""),
          type: "button",
          // closing 动画期间的点击 = 取消关闭并重开(open 仍为 true,不处理
          // 会被当成「再次关闭」吞掉,用户要点两次才能重开)。
          onClick: () => { if (closing) reopenPanel(); else if (open) closePanel(); else setOpen(true); },
          "aria-expanded": open,
          "aria-label": badgeTitle,
          title: badgeTitle
        },
        React.createElement("span", { className: "sa_badgeIcon", "aria-hidden": true },
          React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
            React.createElement("rect", { x: 3, y: 4, width: 18, height: 4, rx: 1 }),
            React.createElement("path", { d: "M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" }),
            React.createElement("path", { d: "M10 12h4" })
          )
        ),
        iconOnly ? null : React.createElement("span", { className: "sa_badgeLabel" }, t("badge")),
        iconOnly ? null : React.createElement("span", { className: "sa_badgeCount" }, String(open ? items.length : badgeCount))
      ),
    open || closing ? React.createElement(React.Fragment, null,
      React.createElement("div", { className: "sa_overlay" + (closing ? " sa_overlay--closing" : ""), onClick: closePanel }),
      React.createElement(
      "div",
      { className: "sa_panel" + (closing ? " sa_panel--closing" : ""), role: "dialog", "aria-modal": true, "aria-label": t("panelTitle"), tabIndex: -1, ref: panelRef },
      React.createElement(
        "div",
        { className: "sa_header" },
        React.createElement("span", { className: "sa_title" }, t("panelTitle")),
        React.createElement(
          "span",
          { style: { display: "inline-flex", gap: "6px", alignItems: "center" } },
          React.createElement("button", { className: "sa_refresh", type: "button", title: t("refresh"), disabled: busy || loading, onClick: load }, t("refresh")),
          React.createElement("button", { className: "sa_iconBtn", type: "button", title: t("close"), "aria-label": t("close"), disabled: busy, onClick: closePanel },
            React.createElement("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": true },
              React.createElement("path", { d: "M6 6l12 12M18 6L6 18" })))
        )
      ),
      // 筛选输入框:子串匹配标题/工作区路径/ID,前端过滤即时生效。
      React.createElement(
        "div",
        { className: "sa_toolbar" },
        React.createElement("input", {
          className: "sa_filterInput",
          type: "search",
          placeholder: t("filterPlaceholder"),
          "aria-label": t("filterPlaceholder"),
          value: filter,
          onChange: (e: any) => setFilter(e.target.value),
        }),
        React.createElement("button", {
          className: "sa_action",
          type: "button",
          title: t("sortByHint"),
          onClick: () => setSortKey((current) => {
            const at = ARCHIVE_SORT_KEYS.indexOf(current);
            // indexOf 未命中（不该发生）时安全回退到默认排序 time。
            return ARCHIVE_SORT_KEYS[(at + 1) % ARCHIVE_SORT_KEYS.length] ?? "time";
          }),
        }, t("sortBy_" + sortKey)),
      ),
      React.createElement(
        "div",
        { className: "sa_toolbar" },
        React.createElement("label", { className: "sa_toolLabel" },
          React.createElement("input", {
            className: "sa_check",
            type: "checkbox",
            checked: allSelected,
            // 部分选中时半选态：否则半选显示为全不选，误导用户以为没勾上。
            ref: (el: any) => { if (el !== null && el !== undefined) el.indeterminate = hasSelection && !allSelected; },
            disabled: busy || selectable.length === 0,
            onChange: (e) => toggleAll(e.target.checked)
          }),
          t("selectAll")
        ),
        React.createElement("span", { className: "sa_count" }, t("selected").replace("{n}", String(selected.size))),
        React.createElement("button", {
          className: "sa_action",
          type: "button",
          disabled: busy || !hasSelection,
          onClick: restoreSelected
        }, t("restore")),
        React.createElement("button", {
          className: "sa_action " + (confirmingDelete ? "sa_actionDanger sa_confirm" : "sa_actionDanger"),
          type: "button",
          disabled: busy || !hasSelection || (needsDeleteAck(selected.size, confirmingDelete) && !deleteAcked),
          onClick: deleteSelected
        }, confirmingDelete
          ? (selected.size > 1 ? t("confirmAll").replace("{n}", String(selected.size)) : t("deleteConfirm"))
          : t("delete"))
      ),
      React.createElement(
        "div",
        { className: "sa_body" },
        notice !== null ? React.createElement("p", { className: notice.kind === "ok" ? "sa_ok" : notice.kind === "warn" ? "sa_warn" : "sa_error", role: "status" }, notice.text) : null,
        error !== null ? React.createElement("p", { className: "sa_error", role: "alert" }, error) : null,
        // 大批量删除的勾选确认条（数量达阈值才出现）：文案说清不可恢复，
        // 主按钮在勾选前禁用——抄宿主 RiskConfirmation 的行为。
        needsDeleteAck(selected.size, confirmingDelete) ? React.createElement(
          "div",
          { className: "sa_ack", role: "alert" },
          React.createElement("p", { className: "sa_ackText" },
            t("deleteConfirmBody").replace("{n}", String(selected.size))),
          React.createElement("label", { className: "sa_ackLabel" },
            React.createElement("input", {
              className: "sa_check",
              type: "checkbox",
              checked: deleteAcked,
              onChange: (e: any) => setDeleteAcked(e.target.checked)
            }),
            t("deleteAcknowledge").replace("{n}", String(selected.size))
          ),
          React.createElement(
            "div",
            { className: "sa_ackActions" },
            React.createElement("button", {
              className: "sa_action",
              type: "button",
              onClick: () => disarmDelete()
            }, t("cancel"))
          )
        ) : null,
        // 加载中明确提示（loading 只由打开面板/手动刷新置位，静默刷新不打扰）：
        // 此前列表已有内容时手动刷新零反馈，首次加载只有一个孤零零的 "…"。
        loading ? React.createElement("p", { className: "sa_loading", role: "status" },
          React.createElement("span", { className: "sa_spin", "aria-hidden": true }),
          t("loading")) : null,
        !loading && items.length === 0 && error === null ? React.createElement(
          "div",
          { style: { display: "flex", flexDirection: "column", alignItems: "center" } },
          React.createElement("svg", { width: 48, height: 48, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, style: { color: "var(--dsw-alias-label-tertiary)", marginTop: "24px" } },
            React.createElement("rect", { x: 4, y: 8, width: 16, height: 12, rx: 2 }),
            React.createElement("path", { d: "M4 8l8-4 8 4" }),
            React.createElement("line", { x1: 9, y1: 14, x2: 15, y2: 14, strokeDasharray: "2 2" })
          ),
          React.createElement("p", { className: "sa_empty", style: { margin: "12px 0" } }, t("empty"))
        // 筛选无匹配(与「完全无归档」区分:提示调整筛选条件)。
        ) : !loading && items.length > 0 && filteredItems.length === 0 ? React.createElement(
          "p",
          { className: "sa_empty", style: { margin: "12px 0" } },
          t("noMatch")
        ) : null,
        items.length > 0 ? React.createElement(
          "ul",
          { className: "sa_rows" },
          visibleItems.map((item) => {
            const isExpanded = expanded === item.sessionId;
            const detail = details.get(item.sessionId);
            const detailPending = detailLoading.has(item.sessionId);
            return React.createElement(
              "li",
              { className: "sa_row" + (busy ? " sa_busy" : ""), key: item.sessionId },
              React.createElement(
                "div",
                { className: "sa_rowHead" },
                React.createElement("input", {
                  className: "sa_check",
                  type: "checkbox",
                  checked: selected.has(item.sessionId),
                  disabled: busy || item.live,
                  title: item.live ? t("runningHint") : void 0,
                  "aria-label": item.title !== null && item.title !== void 0 && item.title !== "" ? item.title : t("noneTitle"),
                  onChange: (e: any) => toggleOne(item.sessionId, e.target.checked)
                }),
                React.createElement(
                  "button",
                  { className: "sa_rowTitle", type: "button", onClick: () => toggleDetail(item), title: t("view") },
                  item.title !== null && item.title !== void 0 && item.title !== "" ? item.title : t("noneTitle")
                ),
                item.live ? React.createElement("span", { className: "sa_live" }, t("live")) : null
              ),
              React.createElement("div", { className: "sa_rowMeta" },
                React.createElement("span", null, formatTime(item.updatedAt)),
                item.cwd !== null && item.cwd !== void 0 ? React.createElement("span", null, " · ", React.createElement("code", null, item.cwd)) : null,
                React.createElement("span", null, " · ", formatBytes(item.size, t))
              ),
              React.createElement(
                "div",
                { className: "sa_rowFoot" },
                React.createElement("span", { className: "sa_rowMeta" },
                  React.createElement("code", null, shortId(item.sessionId)),
                  detail !== void 0 && !detail.error && detail.messageCount !== void 0
                    ? " · " + (detail.truncated === true
                      ? t("messagesTruncated").replace("{n}", String(detail.totalMessageCount !== void 0 ? detail.totalMessageCount : detail.messageCount))
                      : t("messages").replace("{n}", String(detail.messageCount)))
                    : null
                ),
                React.createElement(
                  "div",
                  { className: "sa_rowActions" },
                  React.createElement("button", {
                    className: "sa_action",
                    type: "button",
                    disabled: busy || detailPending,
                    onClick: () => toggleDetail(item)
                  }, isExpanded ? t("collapse") : t("view"))
                )
              ),
              isExpanded ? React.createElement(
                "div",
                { className: "sa_detail" },
                detailPending ? React.createElement("p", { className: "sa_loading" },
                  React.createElement("span", { className: "sa_spin", "aria-hidden": true }),
                  t("loading")) : null,
                detail === void 0 ? null :
                  detail.error !== void 0 ? React.createElement("p", { className: "sa_error" }, detail.error) :
                  !Array.isArray(detail.messages) ? React.createElement("p", { className: "sa_error" }, t("detailLoadFailed")) :
                  detail.messages.length === 0 ? React.createElement("p", { className: "sa_empty" }, t("noMessages")) :
                  detail.messages.map((message: any, index: any) => React.createElement(
                    "div",
                    { className: "sa_msg", key: index },
                    React.createElement("span", { className: "sa_msgRoleChip " + (message.role === "user" ? "sa_msgRoleUser" : "sa_msgRoleAssistant") }, message.role === "user" ? t("user") : t("assistant") + " · " + formatTime(message.time)),
                    React.createElement("span", { className: "sa_msgBubble " + (message.role === "user" ? "sa_msgUser" : "sa_msgAssistant") }, message.text)
                  ))
              ) : null
            );
          }),
          // 分页：还有未渲的行就给“加载更多”，点一次追加一页。
          visibleCount < sortedItems.length ? React.createElement("button", {
            className: "sa_action",
            type: "button",
            style: { display: "block", margin: "4px auto 0" },
            onClick: () => setVisibleCount((current) => current + ARCHIVE_PAGE_SIZE)
          }, t("showMore").replace("{n}", String(sortedItems.length - visibleCount))) : null
        ) : null
      )
    )) : null
  );
}

// ── 插件 apply ───────────────────────────────────────────────────────
// DSH 客户端的 remote.<ns> 服务不会自动生成：必须由客户端代码用
// ctx.remote.$mount(contribution) 显式挂载（官方 dsh-api-remotes 即如此）。
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

export { apply, inject, trapTarget, needsDeleteAck, DELETE_ACK_THRESHOLD, ARCHIVE_PAGE_SIZE };
