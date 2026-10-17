/**
 * ArchiveToolbar.tsx — 归档面板的两行控件：筛选/排序，以及勾选与批量操作。
 *
 * 2026-10-08 从 224 行的 ArchivePanel.tsx 拆出：面板的 createElement 树里这两行
 * 与列表/详情无关，抽出来后主文件只剩布局与列表。
 *
 * @module session-archive/client/ArchiveToolbar
 */

import * as React from "react";
import { ARCHIVE_SORT_KEYS, needsDeleteAck } from "./archive-entries.js";

export function ArchiveToolbar(props: {
  t: any
  selected: any
  detailLoading: any
  busy: any
  confirmingDelete: any
  deleteAcked: any
  filter: any
  setFilter: any
  sortKey: any
  setSortKey: any
  selectable: any
  allSelected: any
  toggleAll: any
  exportSelected: any
  restoreSelected: any
  deleteSelected: any
  hasSelection: any
}): React.ReactNode {
  const { t, selected, detailLoading, busy, confirmingDelete, deleteAcked, filter, setFilter, sortKey, setSortKey, selectable, allSelected, toggleAll, exportSelected, restoreSelected, deleteSelected, hasSelection } = props

  // 两行控件（筛选/排序、勾选与批量操作）同属工具栏，故一起抽。
  return React.createElement(
    React.Fragment,
    null,
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
  )
  )
}
