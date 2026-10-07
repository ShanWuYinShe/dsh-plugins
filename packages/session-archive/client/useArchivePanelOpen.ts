/**
 * useArchivePanelOpen.ts — 归档对话框的开关状态与关闭动画。
 *
 * 2026-10-08 从 190 行的 useArchivePanel.ts 拆出：open/closing 两态、关闭动画的 timer，
 * 以及「动画进行中点徽标 = 取消关闭并重开」的语义；尊重 prefers-reduced-motion
 * （跳过 150ms 动画直接关）。rootRef 一并归这里（点击外部关闭要用它）。
 *
 * @module session-archive/useArchivePanelOpen
 */

import * as React from "react";

export function useArchivePanelOpen() {
  const rootRef = React.useRef<any>(null);
  const [open, setOpen] = React.useState(false);
  const [closing, setClosing] = React.useState(false);

  // 关闭动画的 timer 存句柄:动画进行中点徽标应是「取消关闭、重新打开」,
  // 否则 open 仍为 true 期间的那次点击会被当成再次关闭吞掉,用户需要点
  // 两次才能重开;卸载后也不再触发无意义的回调。
  const closeTimerRef = React.useRef<any>(0);
  const closePanel = React.useCallback(() => {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setOpen(false);
      setClosing(false);
    } else {
      setClosing(true);
      globalThis.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = globalThis.setTimeout(() => {
        setOpen(false);
        setClosing(false);
      }, 150);
    }
  }, []);
  const reopenPanel = React.useCallback(() => {
    globalThis.clearTimeout(closeTimerRef.current);
    setClosing(false);
    setOpen(true);
  }, []);
  // 卸载时取消挂着的关闭动画回调(声明与实现一致;React 下 setState 为 no-op,
  // 但清理让卸载后的行为完全确定)。
  React.useEffect(() => () => globalThis.clearTimeout(closeTimerRef.current), []);

  return { rootRef, open, setOpen, closing, closePanel, reopenPanel }
}
