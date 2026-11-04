/**
 * useArchiveViewState.ts — 归档面板的视图偏好：筛选、排序与分页窗口。
 *
 * 2026-10-08 从 280 行的 useArchivePanel.ts 拆出：筛选/排序持久化到 sessionStorage
 * （标签页内跨刷新保留；隐私模式静默降级），以及「先筛后排、筛选变化回第一页」的派生。
 *
 * @module session-archive/useArchiveViewState
 */

import * as React from "react";
import { ARCHIVE_PAGE_SIZE, ARCHIVE_SORT_KEYS, filterArchived, sortArchived } from "./archive-entries.js";
import type { ArchiveSortKey } from "./archive-entries.js";

/** 分页窗口：记录「上一次展开更多时的筛选条件 + 列表身份 + 行数」。
 * 筛选变化或列表整体替换时 render 期直接回到第一页（不写 state），
 * 避免 effect 回写 render 可推导状态（RULE-074）。 */
interface PaginationWindow {
  filter: string
  items: readonly unknown[]
  visibleCount: number
}

export function useArchiveViewState(deps: {
  items: any[]
}) {
  const { items } = deps

  // 筛选与排序持久化到 sessionStorage(标签页内跨页面重载保留):用户筛出
  // 一组会话后打开详情/误刷新,回来不必重新输入。禁用 sessionStorage 的
  // 环境(隐私模式)静默降级为不持久化。
  const FILTER_STORE_KEY = "sessionArchive.filter";
  const SORT_STORE_KEY = "sessionArchive.sort";
  const [filter, setFilterState] = React.useState(() => {
    try { return sessionStorage.getItem(FILTER_STORE_KEY) ?? ""; } catch { return ""; }
  });
  const setFilter = React.useCallback((value: string) => {
    setFilterState(value);
    try { sessionStorage.setItem(FILTER_STORE_KEY, value); } catch {}
  }, []);
  const [sortKey, setSortKeyState] = React.useState<ArchiveSortKey>(() => {
    try {
      const saved = sessionStorage.getItem(SORT_STORE_KEY);
      return (ARCHIVE_SORT_KEYS as readonly string[]).includes(saved ?? "") ? (saved as ArchiveSortKey) : "time";
    } catch { return "time"; }
  });
  const setSortKey = React.useCallback((next: ArchiveSortKey) => {
    setSortKeyState(next);
    try { sessionStorage.setItem(SORT_STORE_KEY, next); } catch {}
  }, []);
  const filteredItems = React.useMemo(() => filterArchived(items, filter), [items, filter]);
  // 先筛后排:排序在筛选结果上进行,「加载更多」分页按最终顺序切片。
  const sortedItems = React.useMemo(() => sortArchived(filteredItems, sortKey), [filteredItems, sortKey]);
  // 分页窗口是 { filter, items, visibleCount } 的派生对：筛选条件变化或列表
  // 整体替换（手动刷新落地新行）时 render 期直接返回第一页，无需 effect 回写；
  // setVisibleCount 只由「加载更多」手势调用（打开面板不再重置分页）。
  const [pagination, setPagination] = React.useState<PaginationWindow>({ filter: "", items: [], visibleCount: ARCHIVE_PAGE_SIZE });
  const paginationCurrent = pagination.filter === filter && pagination.items === items;
  const visibleCount = paginationCurrent ? pagination.visibleCount : ARCHIVE_PAGE_SIZE;
  const setVisibleCount = React.useCallback((next: number | ((current: number) => number)) => {
    setPagination((current) => {
      const base = current.filter === filter && current.items === items ? current.visibleCount : ARCHIVE_PAGE_SIZE;
      return { filter, items, visibleCount: typeof next === "function" ? next(base) : next };
    });
  }, [filter, items]);
  const visibleItems = sortedItems.slice(0, visibleCount);

  return { filter, setFilter, sortKey, setSortKey, filteredItems, sortedItems, visibleItems, visibleCount, setVisibleCount }
}
