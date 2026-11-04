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
import type { TFunc } from "./locales.js";
import type { ArchiveDetailEntry, ArchiveItem, ArchiveRowCallbacks } from "./panel-types.js";
import { isDetailError } from "./panel-types.js";

export function ArchiveRow(props: {
  /** 本行对应的归档条目（map 回调参数，故不在 hook 解构名单里）。 */
  item: ArchiveItem
  t: TFunc
  selected: ReadonlySet<string>
  /** 展开中的会话 id（null = 全部收起）。 */
  expanded: string | null
  details: ReadonlyMap<string, ArchiveDetailEntry>
  detailLoading: ReadonlySet<string>
  busy: boolean
} & ArchiveRowCallbacks): React.ReactNode {
  const { item, t, selected, expanded, details, detailLoading, busy, toggleOne, toggleDetail, restoreOne, exportOne } = props

  const isExpanded = expanded === item.sessionId;
  const detail = details.get(item.sessionId);
  const detailPending = detailLoading.has(item.sessionId);
  return React.createElement(
    "li",
    // 外层 ArchivePanel 的 map 已用 sessionId 作 key；组件内部的 li 不再设 key
    // （那是个无效属性，React 只认 map 调用的那一层）。
    { className: "sa_row" + (busy ? " sa_busy" : "") + (selected.has(item.sessionId) ? " sa_row--selected" : "") },
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
        detail !== void 0 && !isDetailError(detail) && detail.messageCount !== void 0
          ? " · " + (detail.truncated === true
            ? t("messagesTruncated").replace("{n}", String(detail.totalMessageCount))
            : t("messages").replace("{n}", String(detail.messageCount)))
          : null
      ),
      React.createElement(
        "div",
        { className: "sa_rowActions" },
        !item.live && typeof restoreOne === "function" ? React.createElement("button", {
          className: "sa_action",
          type: "button",
          disabled: busy || detailPending,
          title: t("restoreOneTitle"),
          onClick: (e: any) => {
            e.stopPropagation();
            restoreOne(item.sessionId);
          }
        }, t("restoreOne")) : null,
        !item.live && typeof exportOne === "function" ? React.createElement("button", {
          className: "sa_action",
          type: "button",
          disabled: busy || detailPending,
          title: t("exportMd"),
          onClick: (e: any) => {
            e.stopPropagation();
            exportOne(item.sessionId);
          }
        }, t("exportMd")) : null,
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
        isDetailError(detail) ? React.createElement("p", { className: "sa_error" }, detail.error) :
        !Array.isArray(detail.messages) ? React.createElement("p", { className: "sa_error" }, t("detailLoadFailed")) :
        detail.messages.length === 0 ? React.createElement("p", { className: "sa_empty" }, t("noMessages")) :
        detail.messages.map((message: any, index: any) => React.createElement(
          "div",
          // 消息列表是日志顺序的快照：没有稳定 id，用 time + 序号表达身份
          // （index 单独作 key 在插入/重排后会把 DOM 状态嫁错消息）。
          { className: "sa_msg", key: String(message.time ?? "") + ":" + index },
          React.createElement("span", { className: "sa_msgRoleChip " + (message.role === "user" ? "sa_msgRoleUser" : "sa_msgRoleAssistant") }, message.role === "user" ? t("user") : t("assistant") + " · " + formatTime(message.time)),
          React.createElement("span", { className: "sa_msgBubble " + (message.role === "user" ? "sa_msgUser" : "sa_msgAssistant") }, message.text)
        ))
    ) : null
  );
}
