/**
 * session-scan.ts — 会话文件扫描与读取助手（标题、消息文本、目录归属删除）。
 *
 * 2026-10-08 从 897 行的 src/index.ts 拆出：扫描助手、配置与 host 工厂各自成
 * 模块，入口只保留网关接线与 apply。
 *
 * @module @chaoset/session-archive/session-scan
 */

import { readdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'

/** 「可能活跃」的 mtime 窗口：内存中的会话 60s 内写过文件才值得做增长
 * 观察（生成流可能把半截日志 append 回刚删的路径；窗口外的静默文件无
 * 疑似写入方，直接删）。是否真的忙碌由沉降观察的体积增长判定。 */
export const BUSY_WRITE_WINDOW_MS = 60_000;

/** 复验前的沉降等待：活跃写入方重建路径的典型间隔。 */
export const REAPPEAR_SETTLE_MS = 300;

/**
 * 删除会话文件后清理其所属目录。官方布局(dsh-session-persistence-jsonl)
 * 是"一会话一目录":目录名 = encodeSegment(sessionId),目录归该会话独占。
 * 删除目录前做两道归属校验,任何一道不过就只删文件、保留目录(fail-safe:
 * 宁可留下空壳目录,不可递归多删——布局契约一旦变化,rm -recursive 会
 * 不可逆地连带其他会话的数据):
 *   1. 目录名包含 sessionId 原文字面:官方 encodeSegment 对 UUID 的全部
 *      字符([0-9a-f-],均在保留集内)原样保留;若未来目录名改用哈希等
 *      不含 id 的方案,校验失败,自动降级为仅删文件;
 *   2. 目录内容不含其他会话的 .jsonl(.zstd) 文件——防御"多会话共目录"
 *      的未来布局。
 */
export async function removeSessionDirIfOwned(sessionId: string, filePath: string, warn: (message: string) => void): Promise<void> {
  const dir = dirname(filePath);
  if (dir === '' || dir === '.' || dir === '/') return;
  const base = basename(dir);
  if (!base.includes(sessionId)) {
    warn(`session-archive: session directory "${base}" does not reference session ${sessionId}; keeping it (layout contract changed?)`);
    return;
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // 目录不存在或不可读:无需清理
  }
  const ownFile = basename(filePath);
  for (const entry of entries) {
    if (entry === ownFile) continue;
    // session*.jsonl(.zstd) 是本会话自己的历史代际(官方代际命名 session[.vN]
    // .jsonl[.zstd],目录归属校验已确认整个目录属于该会话),不算他者日志;
    // 其余 .jsonl 一律视为他者。
    if (entry.startsWith('session.') && (entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zstd'))) continue;
    if (entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zstd')) {
      warn(`session-archive: session directory "${base}" holds other session logs; keeping it`);
      return;
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** 标题/详情分块读取的块长（事件数，官方契约 read(offset,length) 的上界，
 * 超界返回空数组）。此前 read(0) 一次性物化全部事件：大日志下峰值内存
 * O(整条日志)、同步 JSON.parse 集中在宿主事件循环上，面板打开（并发 4 路
 * 标题读）拖慢的是整个宿主而不只是面板；分块后峰值 O(块)。 */
const READ_CHUNK_EVENTS = 200;

/**
 * 分块遍历一条会话的事件流（升序、全量），每块交给 onChunk 消费后即可弃，
 * 返回句柄上的会话头。用完 close——不 close 会漏句柄。
 */
export async function scanSession(persistence: SessionPersistence, sessionId: SessionId, onChunk: (events: readonly SessionEvent[]) => void): Promise<SessionHeader> {
  const handle: SessionHandle = await persistence.open(sessionId, 'read');
  try {
    for (let offset = 0; ; offset += READ_CHUNK_EVENTS) {
      const { events } = await handle.read(offset, READ_CHUNK_EVENTS);
      // 损坏/异构日志里可能混进 null 或非对象行（合法 JSON 但不是事件）——
      // 在这里统一剔除，两个消费方（标题折叠、detail 提取）都不必各自防御；
      // 分页终止判定仍用原始长度，空块语义不因剔除改变。
      if (events.length === 0) break;
      onChunk(events.filter((event) => event !== null && typeof event === 'object'));
      if (events.length < READ_CHUNK_EVENTS) break;
    }
    return handle.header;
  } finally {
    await handle.close();
  }
}

/**
 * 读取会话标题（官方 foldSessionTitle 折叠）。fold 只消费最后一个
 * session/title 事件——只收集 title 事件再折叠，与全量折叠语义一致
 * （latest-wins），内存 O(title 事件数)（正常日志恒为 1）。
 */
export async function readTitle(persistence: SessionPersistence, sessionId: SessionId): Promise<string | null> {
  const titleEvents: SessionEvent[] = [];
  await scanSession(persistence, sessionId, (events) => {
    for (const event of events) {
      if (event.type === 'session/title') titleEvents.push(event);
    }
  });
  return foldSessionTitle(titleEvents)?.title ?? null;
}

/** 等待 ms 毫秒（沉降观察、删除窗口用）。 */
export function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 并发限制器：最多 N 个任务并行，其余排队。宽度下限 1——直调
 * createArchiveHost 传 0/负数时若产出 0 个 worker，会静默返回全 undefined
 * 的数组而非报错。 */
export function limitedConcurrency(limit: number, tasks: Array<() => Promise<any>>): Promise<any[]> {
  const results = new Array(tasks.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, tasks.length));
  const workers = Array.from({ length: width }, async () => {
    while (cursor < tasks.length) {
      const at = cursor++;
      const task = tasks[at]!;
      results[at] = await task();
    }
  });
  return Promise.all(workers).then(() => results);
}

/** 从一条消息提取纯文本（text 块拼接，忽略图片/工具块）。
 * 官方 Message.content 是 ContentBlock[]，这里只取 type:'text' 的块。 */
export function messageText(content: unknown, maxChars: number): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === 'text' && typeof (block as any).text === 'string') {
      text += (block as any).text;
      if (text.length > maxChars) break;
    }
  }
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}
