/**
 * ArchiveRow.tsx — 归档列表里的一行（勾选、标题、元信息与展开的详情）。
 *
 * 2026-10-08 从 315 行的 ArchivePanel.tsx 拆出：面板的 createElement 树里，单行渲染
 * 原本是 visibleItems.map 的回调体（约 70 行），抽成命名组件后主文件只剩布局。
 *
 * @module session-archive/client/ArchiveRow
 */

import * as React from "react";
import { formatBytes, formatTime, shortId } from "./archive-format.js";


export function ArchiveRow(props: {
  /** 本行对应的归档条目（map 回调参数，故不在 hook 解构名单里）。 */
  item: any
  t: any
  loading: any
  error: any
  selected: any
  expanded: any
  details: any
  detailLoading: any
  busy: any
  toggleOne: any
  toggleDetail: any
}): React.ReactNode {
  const { item, t, loading, error, selected, expanded, details, detailLoading, busy, toggleOne, toggleDetail } = props

  const isExpanded = expanded === item.sessionId;
  const detail = details.get(item.sessionId);
  const detailPending = detailLoading.has(item.sessionId);
  return React.createElement(
    "li",
    { className: "sa_row" + (busy ? " sa_busy" : "") + (selected.has(item.sessionId) ? " sa_row--selected" : ""), key: item.sessionId },
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
}
