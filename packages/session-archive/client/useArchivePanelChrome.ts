/**
 * useArchivePanelChrome.ts — 归档对话框的「外壳行为」：焦点管理、点击外部关闭、键盘。
 *
 * 2026-10-08 从 useArchivePanel.ts 拆出：打开时焦点移入面板、关闭时归还徽标按钮、
 * 点击面板外关闭、Esc 关闭与 Tab 焦点陷阱（面板声明了 aria-modal），以及提示的自动消失。
 *
 * @module session-archive/useArchivePanelChrome
 */

import * as React from "react";
import { trapTarget } from "./archive-entries.js";

export function useArchivePanelChrome(deps: {
  open: boolean
  notice: any
  setNotice: (next: any) => void
  closePanel: () => void
  badgeRef: React.RefObject<any>
  rootRef: React.RefObject<any>
}) {
  const { open, notice, setNotice, closePanel, badgeRef, rootRef } = deps

  // 对话框焦点管理：打开时把焦点移入面板（键盘/读屏用户不必 Tab 瞎找），
  // 关闭时归还给徽标按钮；prevOpen 避免首次挂载（open=false）误触发归还。
  const panelRef = React.useRef<any>(null);
  const prevOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (open && !prevOpenRef.current) panelRef.current?.focus?.();
    else if (!open && prevOpenRef.current) badgeRef.current?.focus?.();
    prevOpenRef.current = open;
  }, [open]);

  // 提示（如「已恢复/已删除 N 个会话」）几秒后自动消失，避免残留误导用户，
  // 也避免删除全部归档后仍挂着上一条提示。
  React.useEffect(() => {
    if (notice === null) return;
    const id = globalThis.setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: any) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) {
        closePanel();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 面板按键（仅 open 时监听）：Esc 关闭是对话框惯例；Tab 环绕是焦点陷阱——
  // 面板声明了 aria-modal，Tab 不得跑到遮罩后的侧边栏元素上。
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: any) => {
      if (event.key === "Escape") {
        closePanel();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (panel === undefined || panel === null) return;
      const focusables = Array.from(panel.querySelectorAll(
        'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])'
      ));
      const target = trapTarget(focusables, document.activeElement, event.shiftKey === true);
      if (target !== undefined) {
        event.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return { panelRef }
}
