/**
 * archive-format.ts — 体积/时间/短 id 展示格式化与小数组比较。
 *
 * 2026-10-08 从 1194 行的 client/index.tsx 拆出：样式、文案、纯逻辑与面板组件
 * 各自成模块，入口只保留注册与 re-export。
 *
 * @module @chaoset/session-archive/client/archive-format
 */



export function formatBytes(bytes: any, t: any) {
  // 0/缺失(文件已不可 stat)显示占位符,避免误导性的 "0 B"。
  if (bytes === void 0 || bytes === null || Number(bytes) === 0) return "—";
  if (bytes < 1024) return t("sizeBytes").replace("{n}", String(bytes));
  if (bytes < 1024 * 1024) return t("sizeKB").replace("{n}", (bytes / 1024).toFixed(1));
  return t("sizeMB").replace("{n}", (bytes / (1024 * 1024)).toFixed(1));
}

export function formatTime(ms: any) {
  // new Date(不可解析值) 不抛错而是返回 Invalid Date, toLocaleString 返回
  // 字符串 "Invalid Date"——catch 兜不住,须显式判 NaN 后回退原值。
  // host 端 detail 的 time 标注为 unknown,契约不保证可解析。
  try {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? String(ms) : d.toLocaleString();
  } catch { return String(ms); }
}

export function shortId(id: any) {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}
// 列表浅比较(sessionId+updatedAt+size+live):数据没变就不 setItems,
// 静默刷新/重复刷新不再触发整表 reconcile。

export function sameItems(a: any[], b: any[]) {
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
