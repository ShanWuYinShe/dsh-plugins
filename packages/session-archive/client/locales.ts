/**
 * locales.ts — 侧边栏面板的中英文案与命名空间。
 *
 * 2026-10-08 从 1194 行的 client/index.tsx 拆出：样式、文案、纯逻辑与面板组件
 * 各自成模块，入口只保留注册与 re-export。
 *
 * @module @chaoset/session-archive/client/locales
 */



export const NS = "sidebar.sessionArchive";

export const zh = {
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
  exportMd: "导出 Markdown",
  exportDone: "已导出 {n} 个会话",
  exportPartial: "{n} 个会话导出失败",
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

export const en = {
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
  exportMd: "Export Markdown",
  exportDone: "Exported {n} sessions",
  exportPartial: "{n} sessions failed to export",
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

/**
 * 面板组件共用的翻译函数类型：键取自 zh 字典（en 与其同构，取其一即可）。
 * 此前各组件把 t 标成 any，locales 键名拼错只能等运行时空白上屏——
 * 收紧到字典键后拼错直接 typecheck 红。
 */
export type TFunc = (key: keyof typeof zh, params?: Record<string, string | number>) => string
