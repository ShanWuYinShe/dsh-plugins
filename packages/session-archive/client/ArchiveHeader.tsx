/**
 * ArchiveHeader.tsx — 归档面板的表头：标题、计数药丸、刷新与关闭。
 *
 * 2026-10-08 从 141 行的 ArchivePanel.tsx 拆出：计数药丸在筛选生效时显示「命中/总数」，
 * 否则显示总数；刷新按钮重新拉列表，关闭按钮走关闭动画。
 *
 * @module session-archive/ArchiveHeader
 */

import * as React from "react";

export function ArchiveHeader(props: {
  t: any
  closePanel: any
  items: any
  loading: any
  busy: any
  load: any
  filter: any
  sortedItems: any
}): React.ReactNode {
  const { t, closePanel, items, loading, busy, load, filter, sortedItems } = props
  const isRefreshing = Boolean(busy || loading)

  return (
React.createElement(
  "div",
  { className: "sa_header" },
  React.createElement("span", { className: "sa_titleWrap" },
    React.createElement("span", { className: "sa_title" }, t("panelTitle")),
    React.createElement("span", { className: "sa_countPill", "aria-hidden": true },
      filter.trim() !== "" ? String(sortedItems.length) + "/" + String(items.length) : String(items.length))),
  React.createElement(
    "span",
    { className: "sa_headerActions" },
    React.createElement("button", {
      className: "sa_refresh",
      type: "button",
      title: isRefreshing ? t("loading") : t("refresh"),
      "aria-label": isRefreshing ? t("loading") : t("refresh"),
      disabled: isRefreshing,
      onClick: load
    },
      React.createElement("svg", {
        className: isRefreshing ? "sa-spin-icon" : undefined,
        viewBox: "0 0 24 24",
        width: 12,
        height: 12,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        style: { display: "inline-block", flexShrink: 0 },
        "aria-hidden": true
      },
        React.createElement("path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }),
        React.createElement("polyline", { points: "21 3 21 8 16 8" })
      ),
      React.createElement("span", null, t("refresh"))
    ),
    React.createElement("button", { className: "sa_iconBtn", type: "button", title: t("close"), "aria-label": t("close"), disabled: busy, onClick: closePanel },
      React.createElement("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", "aria-hidden": true },
        React.createElement("path", { d: "M6 6l12 12M18 6L6 18" })))
  )
)
  )
}
