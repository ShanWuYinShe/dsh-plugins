/**
 * archive-host-queries.ts — 只读查询：count / list / detail。
 *
 * 2026-10-08 从 archive-host.ts 拆出：方法体逐字保留，只把原先同作用域的助手改为
 * 从 deps 解构（见 archive-host-context.ts）。
 *
 * @module @chaoset/session-archive/archive-host-queries
 */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { scanSession, limitedConcurrency, messageText } from './session-scan.js'
import type { HostContext } from './archive-host-context.js'

export function createArchiveQueries(deps: HostContext) {
  const {
    cfg,
    persistence,
    archivedSet,
    isLive,
    snapshotsByIds,
    readTitlesBulk,
    rowFor,
  } = deps

  return {
    /** 归档会话计数（存在性过滤后的真实数量）。侧边栏徽标的关闭态轮询
     * 只调这里：逐 id stat 只读元数据头，不枚举全部历史会话。 */
    async count() {
      const archived = [...archivedSet()];
      if (archived.length === 0) return { count: 0 };
      const snapshots = await snapshotsByIds(archived);
      return { count: snapshots.size };
    },

    /** 列出全部归档会话（存在性过滤：文件已删的幽灵归档记录不显示）。 */
    async list() {
      const archived = [...archivedSet()];
      if (archived.length === 0) return { items: [] };
      const snapshots = await snapshotsByIds(archived);
      const rows: Array<{ sessionId: string; header: SessionHeader }> = [];
      for (const sessionId of archived) {
        const snapshot = snapshots.get(sessionId);
        if (snapshot === undefined) continue; // 幽灵 id：会话文件已不存在
        rows.push({ sessionId, header: snapshot.header });
      }
      // 标题优先走官方索引批量读（无 sessionQuery/整单失败时 readTitlesBulk
      // 返回 null，逐行回退直读；单行 rejected 同理）。存在性过滤与体积/mtime
      // 仍以文件为准，不受索引影响。
      const bulk = await readTitlesBulk(rows.map(({ sessionId }) => sessionId as SessionId));
      const items = await limitedConcurrency(cfg.titleReadConcurrency, rows.map(({ sessionId, header }) => () => rowFor(sessionId as SessionId, header, bulk)));
      return { items };
    },

    /** 读取一个归档会话的只读详情（标题 + 文本消息）。仅归档会话可读：
     * detail 是对外暴露的远程端点,不校验成员资格就能读到任意未归档会话。 */
    async detail(sessionId: string) {
      if (!archivedSet().has(sessionId)) {
        throw Object.assign(new Error('session not archived: ' + sessionId), { code: 'NOT_ARCHIVED' });
      }
      const id = sessionId as SessionId;
      // 事件流分块消费（readSession 时代 read(0) 一次性物化全部事件）:
      // 头从句柄上取,消息逐块提取,达到上限后只计数不再拼接文本;
      // title 事件同趟收集(fold 只消费最后一个,全量物化没有必要)。
      const titleEvents: SessionEvent[] = [];
      const messages: Array<{ role: 'user' | 'assistant'; text: string; time: unknown }> = [];
      let totalMessageCount = 0;
      const meta = await scanSession(persistence, id, (events) => {
        for (const event of events) {
          if (event.type === 'session/title') {
            titleEvents.push(event);
            continue;
          }
          if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
          // 官方事件 data:user/message 是 UserMessage 本体（content 在自身），
          // assistant/message 是包装对象（content 在 .message.content）。
          // message 可缺（损坏/异构日志）——detail 是整会话只读端点，一条
          // 畸形事件不应让整个请求 TypeError。
          const text = messageText(
            event.type === 'user/message' ? event.data?.content : event.data?.message?.content,
            cfg.messagePreviewChars,
          );
          // 空文本消息（纯工具调用等）在任何位置都不计入总数——截断线两侧
          // 口径一致。放在上限判定之前:不提取文本就无法区分空与非空,
          // 提取成本受 messagePreviewChars 上界约束。
          if (text.length === 0) continue;
          if (messages.length >= cfg.detailMaxMessages) {
            totalMessageCount++;
            continue;
          }
          messages.push({
            role: event.type === 'user/message' ? 'user' : 'assistant',
            text,
            time: event.time,
          });
          totalMessageCount++;
        }
      });
      const title = foldSessionTitle(titleEvents)?.title ?? null;
      return {
        sessionId,
        header: {
          cwd: meta.cwd ?? null,
          createdAt: meta.createdAt,
          parentSession: meta.parentSession ?? null,
          agentPreset: meta.agentPreset ?? null,
        },
        title,
        messageCount: messages.length,
        totalMessageCount,
        truncated: totalMessageCount > messages.length,
        messages,
        live: isLive(id),
      };
    },
  }
}
