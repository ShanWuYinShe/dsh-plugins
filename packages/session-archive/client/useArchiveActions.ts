/**
 * useArchiveActions.ts — 归档面板的勾选与批量操作（含两段式删除的二次确认）。
 *
 * 2026-10-08 从 443 行的 useArchivePanel.ts 拆出：勾选切换、详情展开、批量导出/恢复/删除
 * 与 4 秒确认窗口同属「用户动作」，与视图状态（开关/筛选/排序）分开。
 *
 * @module session-archive/useArchiveActions
 */

import * as React from "react";
import { downloadMarkdown, detailToMarkdown, mergeArchivedMarkdown, needsDeleteAck } from "./archive-entries.js";
import { shortId } from "./archive-format.js";

export function useArchiveActions(deps: {
  /** 宿主会话列表的刷新口（可选；删除/恢复后同步原生页）。 */
  refreshSessions: any
  busy: any
  call: any
  confirmingDelete: any
  deleteAcked: any
  detailLoading: any
  details: any
  error: any
  expanded: any
  filter: any
  items: any
  load: any
  selectable: any
  selected: any
  setBusy: any
  setConfirmingDelete: any
  setDetailLoading: any
  setDetails: any
  setExpanded: any
  setItems: any
  setNotice: any
  setSelected: any
  t: any
}) {
  const { refreshSessions, busy, call, confirmingDelete, deleteAcked, detailLoading, details, error, expanded, filter, items, load, selectable, selected, setBusy, setConfirmingDelete, setDetailLoading, setDetails, setExpanded, setItems, setNotice, setSelected, t } = deps

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
      setSelected(new Set(selectable.map((item: any) => item.sessionId)));
    } else {
      setSelected(new Set());
    }
    // 选择集变化即解除两段式删除的 armed 态:否则 4 秒窗口内改勾选,
    // 第二次点击会把确认"误嫁"给新的选择集。
    disarmDelete();
  };
  const toggleOne = (sessionId: any, checked: any) => {
    setSelected((current: any) => {
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
      setDetailLoading((current: any) => new Set(current).add(item.sessionId));
      call("detail", item.sessionId).then((detail: any) => {
        setDetails((current: any) => new Map(current).set(item.sessionId, detail));
      }).catch((detailError: any) => {
        setDetails((current: any) => new Map(current).set(item.sessionId, {
          error: t("detailLoadFailed") + ": " + (detailError && detailError.message || detailError)
        }));
      }).finally(() => {
        setDetailLoading((current: any) => {
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
    const ids = [...selected].filter((id: any) => {
      const item = items.find((i: any) => i.sessionId === id);
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
        const item = items.find((i: any) => i.sessionId === id);
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
        setItems((current: any) => current.filter((item: any) => !done.has(item.sessionId)));
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
      if (doneIds.length > 0 && typeof refreshSessions === "function") {
        // 删除/恢复后刷新客户端会话列表：原生"设置 → 已归档会话"页的每行是
        // 归档集合 ∩ 会话摘要（byId），cold 会话的文件已删但客户端 byId 缓存
        // 仍留着摘要，不刷新原生页会继续显示已彻底删除的条目。静默失败——本
        // 面板自身的 load() 已保证面板正确，不拿它挡提示。
        try { await refreshSessions(); } catch {}
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

  return {
    disarmDelete,
    toggleAll,
    toggleOne,
    toggleDetail,
    exportSelected,
    restoreSelected,
    deleteSelected,
  }
}
