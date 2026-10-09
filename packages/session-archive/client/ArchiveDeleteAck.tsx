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
import type { TFunc } from "./locales.js";

export function ArchiveDeleteAck(props: {
  t: TFunc
  /** 勾选中的会话 id 集合；size 决定确认条是否出现与计数文案。 */
  selected: ReadonlySet<string>
  /** 两段式删除的第一段（主删除按钮已按）是否在进行中。 */
  confirmingDelete: boolean
  /** 用户已勾选「我确认」。 */
  deleteAcked: boolean
  setDeleteAcked: (next: boolean) => void
  disarmDelete: () => void
}): React.ReactNode {
  const { t, selected, confirmingDelete, deleteAcked, setDeleteAcked, disarmDelete } = props

  // 大批量删除的勾选确认条（数量达阈值才出现）：文案说清不可恢复，
  // 主按钮在勾选前禁用——抄宿主 RiskConfirmation 的行为。
  if (!needsDeleteAck(selected.size, confirmingDelete)) return null

  return React.createElement(
    "div",
    { className: "sa_ack", role: "alert" },
    React.createElement("p", { className: "sa_ackText" },
      // 宿主注入的 t 不做插值（面板各处均手动 replace），保持同一口径。
      t("deleteConfirmBody").replace("{n}", String(selected.size))),
    React.createElement("label", { className: "sa_ackLabel" },
      React.createElement("input", {
        className: "sa_check",
        type: "checkbox",
        checked: deleteAcked,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDeleteAcked(e.target.checked)
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
