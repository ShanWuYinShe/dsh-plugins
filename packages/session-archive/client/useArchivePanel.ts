/**
 * useArchivePanel.ts — 归档面板的状态与行为（原 ArchivePanel 的逻辑半）。
 *
 * 2026-10-08 从 759 行的 ArchivePanel.tsx 拆出：32 个 hooks/回调与一块 250 行的
 * createElement 渲染混在一个函数里，改状态要跨屏滚动、改渲染要避开逻辑。
 * 现在状态与行为在本文件，渲染在 ArchivePanel.tsx（解构后逐字未改）。
 *
 * @module @chaoset/session-archive/client/useArchivePanel
 */

import { shortId } from './archive-format.js'
import {
  filterArchived,
  ARCHIVE_SORT_KEYS,
  sortArchived,
  detailToMarkdown,
  mergeArchivedMarkdown,
  downloadMarkdown,
  trapTarget,
  ARCHIVE_PAGE_SIZE,
  needsDeleteAck,
  type ArchiveSortKey,
} from './archive-entries.js'
import * as React from 'react'
import { useArchiveList } from './useArchiveList.js'
import { useArchiveActions } from './useArchiveActions.js'
import { useArchiveViewState } from './useArchiveViewState.js'

export function useArchivePanel(props: any) {
  const t = props.t;
  const call = props.call;
  // 侧边栏收起（icon rail）时，DSH 通过 wide=false 告知（侧边栏 footer 注入点
  // 下发的是 wide，而非 collapsed）。以 wide 为准；仅当宿主未下发 wide 时，才用
  // ResizeObserver 观察所在格宽度（<80px 视为收起）兜底，避免窄格把文字标签挤变形。
  const wideExplicit = typeof props.wide === "boolean" ? props.wide : void 0;
  const [narrow, setNarrow] = React.useState(false);
  const collapsed = wideExplicit === void 0 ? narrow : !wideExplicit;
  const badgeRef = React.useRef<any>(null);
  React.useEffect(() => {
    const el = badgeRef.current?.parentElement;
    if (el === undefined || el === null || typeof (globalThis as any).ResizeObserver === "undefined") return;
    const ro = new (globalThis as any).ResizeObserver((entries: any[]) => {
      for (const entry of entries) {
        const w = entry.contentRect?.width ?? el.clientWidth;
        setNarrow(w > 0 && w < 80);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 有显式 wide 时完全以宿主状态为准，避免 ResizeObserver 的窄格判断在
  // 展开后仍残留，导致展开态误用 collapsed 样式（图标不居中、文字丢失）。
  const iconOnly = collapsed;
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

  const [selected, setSelected] = React.useState<Set<any>>(new Set());
  const [expanded, setExpanded] = React.useState<any>(null);
  const [details, setDetails] = React.useState<Map<any, any>>(new Map());
  const [detailLoading, setDetailLoading] = React.useState<Set<any>>(new Set());
  const { items, loading, error, badgeCount, visibleCount, load, setItems, setVisibleCount } = useArchiveList({
    call,
    t,
    open,
    subscribeArchived: props.subscribeArchived,
    setSelected,
    archivedCountOf: props.archivedCountOf,
  })

  const [busy, setBusy] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  // 大批量删除的勾选确认（抄宿主 RiskConfirmation“先勾选后可点”的行为）：
  // 确认态解除时由下面的 effect 统一复位，各处不再逐个补。
  const [deleteAcked, setDeleteAcked] = React.useState(false);
  React.useEffect(() => {
    if (!confirmingDelete) setDeleteAcked(false);
  }, [confirmingDelete]);
  const [notice, setNotice] = React.useState<any>(null);

  React.useEffect(() => {
    if (open) { setNotice(null); load(); }
  }, [open, load]);
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

  // 筛选:大归档量下逐页翻找效率低,标题/工作区路径/ID 子串前端过滤
  // (列表本就全量在内存,过滤纯展示层,不发请求)。
  const { filter, setFilter, sortKey, setSortKey, filteredItems, sortedItems, visibleItems } = useArchiveViewState({
    items,
    visibleCount,
    setVisibleCount,
  })

  // 全选只作用于筛选结果:用户筛出一组会话后点全选,期望选中的是
  // 「看得见的这批」,而不是藏在筛选条件之外的全部。
  const selectable = sortedItems.filter((item) => !item.live);
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.sessionId));

  // 两段式删除 armed 态的 4 秒复位 timer：存 id，改勾选/执行/卸载时清掉，
  // 过期 timer 不得在 armed 已解除后再次写 false（方向虽安全，属卫生债）。
  const { disarmDelete, toggleAll, toggleOne, toggleDetail, exportSelected, restoreSelected, deleteSelected } = useArchiveActions({
    refreshSessions: props.refreshSessions,
    busy,
    call,
    confirmingDelete,
    deleteAcked,
    detailLoading,
    details,
    error,
    expanded,
    filter,
    items,
    load,
    selectable,
    selected,
    setBusy,
    setConfirmingDelete,
    setDetailLoading,
    setDetails,
    setExpanded,
    setItems,
    setNotice,
    setSelected,
    t,
  })


  const hasSelection = selected.size > 0;
  // 徽标的 accessible name：icon-only（侧边栏收起）时没有可见文本，
  // aria-label 必须自带语义与数量，不能只依赖 title。
  const shownCount = open ? items.length : badgeCount;
  const badgeTitle = t("badge") + (shownCount > 0 ? " (" + String(shownCount) + ")" : "");

  return {
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
  }
}
