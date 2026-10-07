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
  // 全选只作用于筛选结果:用户筛出一组会话后点全选,期望选中的是
  // 「看得见的这批」,而不是藏在筛选条件之外的全部。
  const selectable = sortedItems.filter((item) => !item.live);
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.sessionId));

  // 两段式删除 armed 态的 4 秒复位 timer：存 id，改勾选/执行/卸载时清掉，
  // 过期 timer 不得在 armed 已解除后再次写 false（方向虽安全，属卫生债）。
  const confirmTimer = React.useRef<any>(0);
  const disarmDelete = () => {
    if (confirmTimer.current !== 0) {
      globalThis.clearTimeout(confirmTimer.current);
      confirmTimer.current = 0;
    }
    setConfirmingDelete(false);
  };
  const toggleAll = (checked: any) => {
    if (checked) {
      setSelected(new Set(selectable.map((item) => item.sessionId)));
    } else {
      setSelected(new Set());
    }
    // 选择集变化即解除两段式删除的 armed 态:否则 4 秒窗口内改勾选,
    // 第二次点击会把确认"误嫁"给新的选择集。
    disarmDelete();
  };
  const toggleOne = (sessionId: any, checked: any) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
    disarmDelete();
  };

  const toggleDetail = (item: any) => {
    if (expanded === item.sessionId) {
      setExpanded(null);
      return;
    }
    setExpanded(item.sessionId);
    // 同一 id 的详情请求在途时不重复发（快速“查看→收起→查看”）：
    // last-write-wins 虽结果一致，但多一次完整事件流解析纯属浪费。
    // 展开态先给，在途请求落定后内容自动出现。
    if (detailLoading.has(item.sessionId)) return;
    const cached = details.get(item.sessionId);
    // 失败结果不缓存拦截:之前把 {error} 写进 Map 后 has() 恒真,唯一出路是
    // 刷新页面;现在再次点击即重新请求。
    if (cached === void 0 || cached.error !== void 0) {
      setDetailLoading((current) => new Set(current).add(item.sessionId));
      call("detail", item.sessionId).then((detail: any) => {
        setDetails((current) => new Map(current).set(item.sessionId, detail));
      }).catch((detailError: any) => {
        setDetails((current) => new Map(current).set(item.sessionId, {
          error: t("detailLoadFailed") + ": " + (detailError && detailError.message || detailError)
        }));
      }).finally(() => {
        setDetailLoading((current) => {
          const next = new Set(current);
          next.delete(item.sessionId);
          return next;
        });
      });
    }
  };

  /** 批量导出勾选会话为单个 Markdown 文件：确保每个会话的详情已加载
   * （未加载的逐个请求），逐个生成 Markdown 后合并下载。任一会话加载
   * 失败则跳过该会话并在完成提示中说明。 */
  const exportSelected = React.useCallback(async (): Promise<void> => {
    const ids = [...selected].filter((id) => {
      const item = items.find((i) => i.sessionId === id);
      return item !== undefined && !item.live;
    });
    if (ids.length === 0) {
      setNotice({ kind: "warn", text: t("noSelection") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const sections: string[] = [];
      const failed: string[] = [];
      for (const id of ids) {
        const item = items.find((i) => i.sessionId === id);
        try {
          const detail = await call("detail", id);
          sections.push(detailToMarkdown(item ?? { sessionId: id, title: null, cwd: null }, detail));
        } catch (detailError: any) {
          failed.push(String(detailError && detailError.message || detailError));
        }
      }
      if (sections.length > 0) {
        downloadMarkdown("archived-sessions-" + new Date().toISOString().slice(0, 10) + ".md", mergeArchivedMarkdown(sections));
      }
      setNotice(failed.length > 0
        ? { kind: "warn", text: t("exportPartial").replace("{n}", String(failed.length)) + ": " + failed.join(t("joiner")) }
        : { kind: "ok", text: t("exportDone").replace("{n}", String(sections.length)) });
    } finally {
      setBusy(false);
    }
  }, [selected, items, call, t]);

  const runBatch = async (action: any, doneKey: any, failKey: any) => {
    const ids = [...selected];
    if (ids.length === 0) {
      setNotice({ kind: "warn", text: t("noSelection") });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await call(action, ids);
      const doneIds = result.deleted || result.restored || [];
      const n = doneIds.length;
      const doneText = t(doneKey).replace("{n}", String(n));
      // delete 成功但内存会话仍在的 id：原生"设置 → 已归档会话"页按归档集合
      // JOIN 会话摘要展示，ghost 保留 + 内存摘要仍在 → 该页在宿主重启前仍会
      // 显示这些条目。如实提示，不让用户以为删除没生效。
      const restartIds = Array.isArray(result.needsRestart) ? result.needsRestart : [];
      const restartText = restartIds.length > 0
        ? t("restartNeeded").replace("{n}", String(restartIds.length))
        : null;
      if (Array.isArray(result.failed) && result.failed.length > 0) {
        // host 对每个失败项都给了 reason( live/busy/unenumerable/not-archived
        // /not-restorable/具体错误),只报数量会让用户不知道为什么失败、该等
        // 多久重试。全部本地化,未知 reason 原样透出兜底。
        const reasonText = (reason: any) => {
          const map: Record<string, any> = {
            live: t("live"),
            busy: t("runningHint"),
            unenumerable: t("reasonUnenumerable"),
            unlocatable: t("reasonUnlocatable"),
            reappeared: t("reasonReappeared"),
            "not-archived": t("reasonNotArchived"),
            "not-restorable": t("reasonNotRestorable"),
          };
          return map[String(reason)] ?? String(reason ?? "error");
        };
        const detail = result.failed.slice(0, 3)
          .map((item: any) => shortId(item.sessionId) + ": " + reasonText(item.reason))
          .join("; ");
        const more = result.failed.length > 3 ? " (+" + (result.failed.length - 3) + ")" : "";
        const failText = t(failKey).replace("{n}", String(result.failed.length)) + " — " + detail + more;
        // 全失败才用 error 样式;部分成功是 warn,成功计数也要如实带上,
        // 不能只报失败让用户以为一个都没成。附带 needsRestart 时同样 warn。
        if (n > 0) setNotice({ kind: "warn", text: doneText + t("joiner") + " " + failText + (restartText !== null ? t("joiner") + " " + restartText : "") });
        else setNotice({ kind: "error", text: failText });
      } else if (restartText !== null) {
        setNotice({ kind: "warn", text: doneText + t("joiner") + " " + restartText });
      } else {
        setNotice({ kind: "ok", text: doneText });
      }
      if (doneIds.length > 0) {
        const done = new Set(doneIds);
        setItems((current) => current.filter((item) => !done.has(item.sessionId)));
        // 已删除会话的详情/展开态一并清掉：Map 残留会让内存缓慢增长，
        // 展开态残留则指向一个已不存在的行。
        setDetails((current: any) => {
          const next = new Map(current);
          for (const id of done) next.delete(id);
          return next.size === current.size ? current : next;
        });
        setExpanded((current: any) => (current !== null && done.has(current) ? null : current));
      }
      setSelected(new Set());
      disarmDelete();
      if (doneIds.length > 0 && typeof props.refreshSessions === "function") {
        // 删除/恢复后刷新客户端会话列表：原生"设置 → 已归档会话"页的每行是
        // 归档集合 ∩ 会话摘要（byId），cold 会话的文件已删但客户端 byId 缓存
        // 仍留着摘要，不刷新原生页会继续显示已彻底删除的条目。静默失败——本
        // 面板自身的 load() 已保证面板正确，不拿它挡提示。
        try { await props.refreshSessions(); } catch {}
      }
      await load();
    } catch (actionError: any) {
      // 异常分支(整单失败,不是部分失败):带请求发出时的数量,与部分失败分支措辞区分。
      setNotice({ kind: "error", text: t("batchError").replace("{n}", String(ids.length)) + ": " + (actionError && actionError.message || actionError) });
    } finally {
      setBusy(false);
    }
  };
  const restoreSelected = () => runBatch("unarchive", "restoreDone", "restoreFailed");
  const deleteSelected = () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      if (confirmTimer.current !== 0) globalThis.clearTimeout(confirmTimer.current);
      confirmTimer.current = globalThis.setTimeout(() => {
        confirmTimer.current = 0;
        setConfirmingDelete(false);
      }, 4000);
      return;
    }
    // 大批量且未勾选确认框：第二次点击也不执行，等勾选（工具栏按钮同样
    // 禁用中，双保险防“双击节奏穿透”）。
    if (needsDeleteAck(selected.size, confirmingDelete) && !deleteAcked) return;
    runBatch("delete", "deleteDone", "deleteFailed");
  };

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
