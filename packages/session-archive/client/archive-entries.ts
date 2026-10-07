/**
 * archive-entries.ts — 归档条目的筛选、排序、导出与 Markdown 生成（纯函数，单测直接覆盖）。
 *
 * 2026-10-08 从 1194 行的 client/index.tsx 拆出：样式、文案、纯逻辑与面板组件
 * 各自成模块，入口只保留注册与 re-export。
 *
 * @module @chaoset/session-archive/client/archive-entries
 */



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

/** 会话导出文件名：标题安全化（非法字符换 -，截 40 字符），无标题用 ID。 */
export function exportFilename(item: { title: unknown; sessionId: unknown }): string {
  const base = String(item.title ?? "").replace(/[-\\/:*?"<>|\\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return "archive-" + (base || String(item.sessionId).slice(0, 12)) + ".md";
}

/** 把 detail（标题 + user/assistant 文本消息）格式化为 Markdown 文本。 */
export function detailToMarkdown(item: { title: unknown; sessionId: unknown; cwd: unknown }, detail: {
  sessionId?: unknown
  messages?: Array<{ role?: unknown; text?: unknown; time?: unknown }>
}): string {
  const lines: string[] = [];
  lines.push("# " + (String(item.title ?? "") || String(item.sessionId ?? "")));
  lines.push("");
  lines.push("- session: `" + String(item.sessionId ?? "") + "`");
  if (item.cwd !== null && item.cwd !== undefined && item.cwd !== "") lines.push("- workspace: `" + String(item.cwd) + "`");
  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  lines.push("- messages: " + messages.length);
  lines.push("");
  for (const message of messages) {
    const role = message?.role === "user" ? "user" : "assistant";
    lines.push("## " + role);
    lines.push("");
    lines.push(String(message?.text ?? ""));
    lines.push("");
  }
  return lines.join("\n");
}

/** 合并多个会话的 Markdown（--- 分页线分隔），供批量导出为单个文件。 */
export function mergeArchivedMarkdown(sections: readonly string[]): string {
  return sections.filter((s) => s !== "").join("\n\n---\n\n");
}

/** 触发浏览器下载一段文本（Blob 一次性链接，用完即回收）。 */
export function downloadMarkdown(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function trapTarget(focusables: any[], active: any, shift: boolean): any | undefined {
  if (focusables.length === 0) return undefined;
  if (shift && active === focusables[0]) return focusables[focusables.length - 1];
  if (!shift && active === focusables[focusables.length - 1]) return focusables[0];
  return undefined;
}

// 大批量彻底删除的二次确认阈值：达到该数量的删除不再允许“同按钮双击
// 穿透”，必须经下面的 needsDeleteAck 闸（勾选确认框后才可点——抄宿主
// RiskConfirmation 的行为，不引用其实现）。

export const DELETE_ACK_THRESHOLD = 5;
// 归档列表分页步长：全量渲染几百行会卡，默认只渲第一页，“加载更多”追加。

export const ARCHIVE_PAGE_SIZE = 50;

export function needsDeleteAck(selectedSize: number, confirming: boolean): boolean {
  return confirming && selectedSize >= DELETE_ACK_THRESHOLD;
}

// ── 归档面板 ─────────────────────────────────────────────────────────
