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

export function useArchiveViewState(deps: {
  items: any[]
  visibleCount: number
  setVisibleCount: (next: number) => void
}) {
  const { items, visibleCount, setVisibleCount } = deps

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
  // 筛选变化回到第一页:否则 narrowed 结果落在已翻过的页码之外,看似空列表。
  React.useEffect(() => { setVisibleCount(ARCHIVE_PAGE_SIZE); }, [filter]);
  const visibleItems = sortedItems.slice(0, visibleCount);

  return { filter, setFilter, sortKey, setSortKey, filteredItems, sortedItems, visibleItems }
}
