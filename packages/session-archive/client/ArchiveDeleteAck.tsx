/**
 * ArchiveDeleteAck.tsx — 大批量删除的勾选确认条。
 *
 * 2026-10-08 从 ArchivePanel.tsx 拆出：数量达到阈值时出现，文案说清不可恢复，
 * 主按钮在勾选前禁用（抄宿主 RiskConfirmation 的行为）。
 *
 * @module session-archive/client/ArchiveDeleteAck
 */

import * as React from "react";
import { needsDeleteAck } from "./archive-entries.js";

export function ArchiveDeleteAck(props: {
  t: any
  selected: any
  confirmingDelete: any
  deleteAcked: any
  setDeleteAcked: any
  disarmDelete: any
}): React.ReactNode {
  const { t, selected, confirmingDelete, deleteAcked, setDeleteAcked, disarmDelete } = props

  // 大批量删除的勾选确认条（数量达阈值才出现）：文案说清不可恢复，
  // 主按钮在勾选前禁用——抄宿主 RiskConfirmation 的行为。
  if (!needsDeleteAck(selected.size, confirmingDelete)) return null

  return React.createElement(
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
  )
}
