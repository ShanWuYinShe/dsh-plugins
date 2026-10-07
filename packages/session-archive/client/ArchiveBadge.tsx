/**
 * ArchiveBadge.tsx — 侧边栏的归档徽标按钮（收起态只显示图标与计数）。
 *
 * 2026-10-08 从 245 行的 ArchivePanel.tsx 拆出：徽标是面板之外独立的一块，
 * 点击语义（关闭动画中=取消关闭、已开=关、未开=开）自成一体。
 *
 * @module session-archive/client/ArchiveBadge
 */

import * as React from "react";

export function ArchiveBadge(props: {
  t: any
  badgeRef: any
  iconOnly: any
  open: any
  setOpen: any
  closing: any
  closePanel: any
  reopenPanel: any
  items: any
  badgeCount: any
  badgeTitle: any
}): React.ReactNode {
  const { t, badgeRef, iconOnly, open, setOpen, closing, closePanel, reopenPanel, items, badgeCount, badgeTitle } = props

  return (
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
  )
  )
}
