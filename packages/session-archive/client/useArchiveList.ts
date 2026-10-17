/**
 * useArchiveList.ts — 归档列表数据源（items / loading / error / 徽标计数 / 分页窗口）。
 *
 * 2026-10-08 从 561 行的 useArchivePanel.ts 拆出：三条刷新路径（打开时 load、
 * 关闭态 5s 徽标轮询、打开态 30s 静默刷新）与宿主 workspaces store 订阅同属一件事；
 * 请求纪元守卫、勾选剔除、徽标自我纠正的说明都随代码搬到这里。
 *
 * @module session-archive/useArchiveList
 */

import { sameItems } from './archive-format.js'
import { ARCHIVE_PAGE_SIZE } from './archive-entries.js'
import * as React from 'react'

export function useArchiveList({ call, t, open, subscribeArchived, archivedCountOf, setSelected }: {
  call: any
  t: any
  open: boolean
  /** 宿主归档集合 store 的订阅/计数口（不可用时静默退回纯轮询）。 */
  subscribeArchived: any
  archivedCountOf: any
  /** 落地新列表时顺带剔除已消失 id 的残留勾选（见 applyItems 注释）。 */
  setSelected: any
}) {
  const [items, setItems] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<any>(null);

  // 关闭态徽标计数（由 count() 轻端点轮询维护；列表落地时也会同步）。
  const [badgeCount, setBadgeCount] = React.useState(0);
  // 列表分页：只渲前 visibleCount 行；打开/手动刷新回到第一页，
  // 静默刷新不碰（不打断用户已展开的“更多”）。
  const [visibleCount, setVisibleCount] = React.useState(ARCHIVE_PAGE_SIZE);

  // 列表落地（加载与静默刷新共用）：sameItems 比较避免无变化时整表
  // reconcile；同时剔除已消失 id 的残留勾选——否则"已选 N 项"虚高，
  // 还可能把幽灵 id 发给批量操作（host 有幂等兜底，但不该依赖它）。
  // 顺手用列表长度同步徽标计数：count() 端点不可用（host 旧进程未重启、
  // RPC 失败被吞）时，开/关一次面板徽标也能自我纠正，不会卡在 0。
  const applyItems = React.useCallback((next: any[]) => {
    setItems((current) => (sameItems(current, next) ? current : next));
    setBadgeCount(next.length);
    const nextIds = new Set(next.map((item: any) => item.sessionId));
    setSelected((currentSelected: Set<any>) => {
      const pruned = [...currentSelected].filter((id) => nextIds.has(id));
      return pruned.length === currentSelected.size ? currentSelected : new Set(pruned);
    });
  }, []);
  // list 请求纪元:打开态有三条并发 list 来源(30s tick、订阅事件、批量
  // 操作的收尾 load),乱序落地时后到的旧响应会把刚删除/恢复的行「复活」
  // 并连同过期徽标计数写回,直到下一轮刷新才自愈。落地前必须确认自己是
  // 最新一次请求。
  const listSeqRef = React.useRef(0);
  const load = React.useCallback(async () => {
    const seq = ++listSeqRef.current;
    setLoading(true);
    setError(null);
    setVisibleCount(ARCHIVE_PAGE_SIZE);
    try {
      const result = await call("list");
      if (seq !== listSeqRef.current) return;
      applyItems(Array.isArray(result.items) ? result.items : []);
    } catch (loadError: any) {
      if (seq !== listSeqRef.current) return;
      setError(t("loadFailed") + ": " + (loadError && loadError.message || loadError));
    } finally {
      // 纪元守卫:旧 load 迟到时不得提前关掉更新的、仍在途的 load 的 spinner。
      if (seq === listSeqRef.current) setLoading(false);
    }
  }, [call, applyItems, t]);
  // 打开态的静默刷新：不碰 loading，长开面板的列表不再陈旧；
  // sameItems 比较保证数据没变时不触发任何重渲染，不打断勾选。
  // 成功时顺带清掉旧的加载失败提示（error 一旦出现,静默刷新成功
  // 也不清的话会长期挂在已填充的列表上方误导用户）。
  const silentList = React.useCallback(async () => {
    const seq = ++listSeqRef.current;
    try {
      const result = await call("list");
      if (seq !== listSeqRef.current) return;
      setError(null);
      applyItems(Array.isArray(result.items) ? result.items : []);
    } catch {}
  }, [call, applyItems]);


  // 后台静默刷新归档计数：侧边栏徽标要在「聊天列表里出现归档」时就同步显示数量，
  // 而不是等到打开弹窗才更新。面板打开时由上面的 load() 负责，这里只在关闭态轮询，
  // 避免刷新打断用户在面板里的勾选/操作。关闭态走 count() 轻端点：list() 要解析
  // 每个归档会话的完整事件流,5 秒一次的徽标轮询用它是持续的性能债。
  // 标签页隐藏时暂停 interval（隐藏页的轮询是纯浪费），恢复可见时立即刷一次并重启。
  const refreshSilently = React.useCallback(async () => {
    try {
      const result = await call("count");
      setBadgeCount(typeof result.count === "number" ? result.count : 0);
    } catch {
      // count() 不可用（host 进程旧于 lib、端点缺失等）：退回一次 list()，
      // applyItems 会同步徽标计数——宁可贵一点也不让徽标卡在过期值。
      try {
        const result = await call("list");
        applyItems(Array.isArray(result.items) ? result.items : []);
      } catch {}
    }
  }, [call, applyItems]);
  React.useEffect(() => {
    if (open) return;
    let id: any = 0;
    const start = () => { if (id === 0) id = globalThis.setInterval(refreshSilently, 5000); };
    const stop = () => { if (id !== 0) { globalThis.clearInterval(id); id = 0; } };
    const onVis = () => {
      if (document.visibilityState === "visible") { refreshSilently(); start(); }
      else stop();
    };
    if (document.visibilityState === "visible") { refreshSilently(); start(); }
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [open, refreshSilently]);

  // 打开态低频兜底刷新（30s）+ 恢复可见立即刷：面板长开时列表保持新鲜，
  // 且不与关闭态徽标轮询叠加。
  React.useEffect(() => {
    if (!open) return;
    const id = globalThis.setInterval(silentList, 30000);
    const onVis = () => { if (document.visibilityState === "visible") silentList(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { globalThis.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [open, silentList]);

  // 实时同步：订阅宿主 workspaces 服务的归档集合 store。用户在会话列表点
  // 「归档」、其它标签页变更、或宿主推送 host/archived-sessions-changed 时，
  // installArchived 都会触发 store 通知——这里立即重取 count（面板打开时
  // 顺带刷新列表），不必等 5 秒轮询。store 不可用时静默退回纯轮询。
  // 归档集合含 ghost id（已删除仍占位的记录），与 count() 的存在性过滤
  // 口径不同，因此只把集合变化当信号，数目仍以 count() 结果为准。
  const openRef = React.useRef(open);
  React.useEffect(() => { openRef.current = open; }, [open]);
  React.useEffect(() => {
    if (typeof subscribeArchived !== "function" || typeof archivedCountOf !== "function") return;
    let lastCount = archivedCountOf();
    const unsubscribe = subscribeArchived(() => {
      const n = archivedCountOf();
      if (typeof n !== "number" || n < 0 || n === lastCount) return;
      lastCount = n;
      refreshSilently();
      if (openRef.current) silentList();
    });
    return unsubscribe;
  }, [subscribeArchived, archivedCountOf, refreshSilently, silentList]);

  return {
    items,
    loading,
    error,
    badgeCount,
    visibleCount,
    load,
    setItems,
    setVisibleCount,
  }
}
