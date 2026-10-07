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
import { useArchivePanelChrome } from './useArchivePanelChrome.js'
import { useArchiveBadgeVisibility } from './useArchiveBadgeVisibility.js'
import { useArchivePanelOpen } from './useArchivePanelOpen.js'

export function useArchivePanel(props: any) {
  const t = props.t;
  const call = props.call;
  const { collapsed, iconOnly, badgeRef } = useArchiveBadgeVisibility(props.wide)

  const { rootRef, open, setOpen, closing, closePanel, reopenPanel } = useArchivePanelOpen()

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
  const { panelRef } = useArchivePanelChrome({ open, notice, setNotice, closePanel, badgeRef, rootRef })


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
