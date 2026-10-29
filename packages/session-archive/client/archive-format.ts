/**
 * archive-format.ts — 体积/时间/短 id 展示格式化与小数组比较。
 *
 * @module @chaoset/session-archive/client/archive-format
 */

/** locale 绑定后的文案函数。 */
type Translate = (key: string) => string;

/** 一个归档会话行里参与展示与浅比较的字段（列表行 / 面板行的公共子集）。 */
interface ArchiveRowIdentity {
  sessionId: string;
  updatedAt: number;
  size: number;
  live: boolean;
}

export function formatBytes(bytes: number | null | undefined, t: Translate): string {
  // 0/缺失（文件已不可 stat）显示占位符，避免误导性的 "0 B"。
  if (bytes === void 0 || bytes === null || Number(bytes) === 0) return "—";
  if (bytes < 1024) return t("sizeBytes").replace("{n}", String(bytes));
  if (bytes < 1024 * 1024) return t("sizeKB").replace("{n}", (bytes / 1024).toFixed(1));
  return t("sizeMB").replace("{n}", (bytes / (1024 * 1024)).toFixed(1));
}

export function formatTime(ms: number): string {
  // new Date(不可解析值) 不抛错而是返回 Invalid Date，toLocaleString 返回
  // 字符串 "Invalid Date"——catch 兜不住，须显式判 NaN 后回退原值。
  try {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
  } catch { return String(ms); }
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

// 列表浅比较（sessionId+updatedAt+size+live）：数据没变就不 setItems，
// 静默刷新/重复刷新不再触发整表 reconcile。
export function sameItems(a: readonly ArchiveRowIdentity[], b: readonly ArchiveRowIdentity[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x === void 0 || y === void 0) return false;
    if (x.sessionId !== y.sessionId || x.updatedAt !== y.updatedAt || x.size !== y.size || x.live !== y.live) return false;
  }
  return true;
}
