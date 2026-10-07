/**
 * useArchiveBadgeVisibility.ts — 侧边栏徽标的收起判定（icon rail 形态）。
 *
 * 2026-10-08 从 useArchivePanel.ts 拆出：DSH 通过 wide=false 告知侧边栏收起
 * （footer 注入点下发的是 wide，而非 collapsed）；仅当宿主未下发 wide 时，才用
 * ResizeObserver 观察所在格宽度（<80px 视为收起）兜底，避免窄格把文字标签挤变形。
 *
 * @module session-archive/useArchiveBadgeVisibility
 */

import * as React from "react";

export function useArchiveBadgeVisibility(wide: unknown) {
  // 侧边栏收起（icon rail）时，DSH 通过 wide=false 告知（侧边栏 footer 注入点
  // 下发的是 wide，而非 collapsed）。以 wide 为准；仅当宿主未下发 wide 时，才用
  // ResizeObserver 观察所在格宽度（<80px 视为收起）兜底，避免窄格把文字标签挤变形。
  const wideExplicit = typeof wide === "boolean" ? wide : void 0;
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

  return { collapsed, iconOnly, badgeRef }
}
