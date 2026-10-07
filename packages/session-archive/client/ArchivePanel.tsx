/**
 * ArchivePanel.tsx — 侧边栏归档面板：只负责渲染。
 *
 * 状态与行为见 ./useArchivePanel.js（2026-10-08 拆出）。本函数的渲染体是
 * 拆分前逐字保留的，仅把原来同作用域的局部名改为从 hook 返回值解构。
 *
 * @module @chaoset/session-archive/client/ArchivePanel
 */

import * as React from 'react'
import { formatBytes, formatTime, shortId } from './archive-format.js'
import { ARCHIVE_SORT_KEYS, ARCHIVE_PAGE_SIZE, needsDeleteAck } from './archive-entries.js'
import { useArchivePanel } from './useArchivePanel.js'
import { ArchiveRow } from './ArchiveRow.js'
import { ArchiveBadge } from './ArchiveBadge.js'

export function ArchivePanel(props: any) {
  const {
    t,
    collapsed,
    badgeRef,
    iconOnly,
    rootRef,
    open,
    setOpen,
    closing,
    closePanel,
    reopenPanel,
    items,
    loading,
    error,
    selected,
    expanded,
    details,
    detailLoading,
    busy,
    confirmingDelete,
    deleteAcked,
    setDeleteAcked,
    notice,
    badgeCount,
    visibleCount,
    setVisibleCount,
    load,
    panelRef,
    filter,
    setFilter,
    sortKey,
    setSortKey,
    filteredItems,
    sortedItems,
    visibleItems,
    selectable,
    allSelected,
    disarmDelete,
    toggleAll,
    toggleOne,
    toggleDetail,
    exportSelected,
    restoreSelected,
    deleteSelected,
    hasSelection,
    badgeTitle,
  } = useArchivePanel(props)

  return React.createElement(
    "div",
    { className: "sa_root", ref: rootRef },
      React.createElement(ArchiveBadge, { t, badgeRef, iconOnly, open, setOpen, closing, closePanel, reopenPanel, items, badgeCount, badgeTitle }),
    open || closing ? React.createElement(React.Fragment, null,
      React.createElement("div", { className: "sa_overlay" + (closing ? " sa_overlay--closing" : ""), onClick: closePanel }),
      React.createElement(
      "div",
      { className: "sa_panel" + (closing ? " sa_panel--closing" : ""), role: "dialog", "aria-modal": true, "aria-label": t("panelTitle"), tabIndex: -1, ref: panelRef },
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
          onClick: () => {
            // setSortKey 持久化后为值形式(非函数式更新器):从 state 读当前键
            // 计算下一个;indexOf 未命中(不该发生)时安全回退默认排序 time。
            const at = ARCHIVE_SORT_KEYS.indexOf(sortKey);
            setSortKey(ARCHIVE_SORT_KEYS[(at + 1) % ARCHIVE_SORT_KEYS.length] ?? "time");
          },
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
          : t("delete")),
        React.createElement("button", {
          className: "sa_action",
          type: "button",
          disabled: busy || !hasSelection || detailLoading.size > 0,
          title: t("exportMd"),
          onClick: () => void exportSelected(),
        }, t("exportMd"))
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
          visibleItems.map((item) => React.createElement(ArchiveRow, { key: item.sessionId, item, t, loading, error, selected, expanded, details, detailLoading, busy, toggleOne, toggleDetail })),
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

