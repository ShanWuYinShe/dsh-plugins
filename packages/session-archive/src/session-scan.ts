/**
 * session-scan.ts — 会话文件扫描与读取助手（标题、消息文本、目录归属删除）。
 *
 * 2026-10-08 从 897 行的 src/index.ts 拆出：扫描助手、配置与 host 工厂各自成
 * 模块，入口只保留网关接线与 apply。
 *
 * @module @chaoset/session-archive/session-scan
 */

import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'

/** 「可能活跃」的 mtime 窗口：内存中的会话 60s 内写过文件才值得做增长
 * 观察（生成流可能把半截日志 append 回刚删的路径；窗口外的静默文件无
 * 疑似写入方，直接删）。是否真的忙碌由沉降观察的体积增长判定。 */
export const BUSY_WRITE_WINDOW_MS = 60_000;

/** 复验前的沉降等待：活跃写入方重建路径的典型间隔。 */
export const REAPPEAR_SETTLE_MS = 300;

/** 官方 jsonl 后端的会话日志代际命名：session.jsonl / session.vN.jsonl /
 * session.jsonl.zstd / session.vN.jsonl.zstd。官方布局「一会话一目录」下，
 * 目录内该命名族文件都是同一会话的历史代际，不算他者日志。 */
function isGenerationFile(entry: string): boolean {
  return entry.startsWith('session.') && (entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zstd'));
}

/** 读取目录条目；目录不存在返回 null（无可清理残留），其余错误上抛——
 * 无法确认残留是否存在时 fail-closed，由调用方把该 id 记 failed。 */
async function readdirOrNull(dir: string): Promise<string[] | null> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 只清理本会话代际命名族文件（不动他者日志、不递归），复扫确认没有残留。
 * 返回仍残留的条目：rm 失败、或删除窗口内被写入方重建的，都算残留——
 * 调用方据此把该会话记 failed，不得谎报「已彻底删除」。
 * @param dir - 会话日志所在目录。
 * @param ownFile - 调用方已单独删除的文件名（本助手不代删，保持原契约）。
 * @param warn - 宿主 logger 告警通道。
 * @returns 仍残留的代际文件条目（空数组即清理干净）。
 */
async function clearGenerationResidue(dir: string, ownFile: string, warn: (message: string) => void): Promise<string[]> {
  const entries = await readdirOrNull(dir);
  if (entries === null) return [];
  const residue = new Set<string>();
  for (const entry of entries) {
    if (entry === ownFile || !isGenerationFile(entry)) continue;
    try {
      await rm(join(dir, entry), { force: true });
    } catch (error) {
      residue.add(entry);
      warn(`session-archive: failed to remove stale session generation "${entry}" in "${dir}": ${String(error)}`);
    }
  }
  // 复扫确认：rm 成功后仍可能被迁移/重建（rename 型格式迁移的临时文件族），
  // 或以目录形态占位导致 rm 实际未删（EISDIR 等）。
  const remaining = await readdirOrNull(dir);
  if (remaining !== null) {
    for (const entry of remaining) {
      if (entry !== ownFile && isGenerationFile(entry)) residue.add(entry);
    }
  }
  return [...residue];
}

/**
 * 删除会话文件后清理其所属目录/残留代际。官方布局(dsh-session-persistence-jsonl)
 * 是"一会话一目录":目录名 = encodeSegment(sessionId),目录归该会话独占。
 * 删除目录前做两道归属校验,不通过时绝不递归删目录(fail-safe:布局契约一旦
 * 变化,rm -recursive 会不可逆地连带其他会话的数据):
 *   1. 目录名包含 sessionId 原文字面:官方 encodeSegment 对 UUID 的全部
 *      字符([0-9a-f-],均在保留集内)原样保留;若未来目录名改用哈希等
 *      不含 id 的方案,校验失败,降级为只清理本会话代际命名族文件;
 *   2. 目录内容不含其他会话的 .jsonl(.zstd) 文件——防御"多会话共目录"
 *      的未来布局。命中时同样降级为逐文件清理本会话代际。
 *
 * 降级路径必须清掉本会话全部旧代际（session[.vN].jsonl[.zstd]）：只删
 * stat 定位到的那一个文件会让同会话旧代际残留在磁盘上，而调用方却把该 id
 * 记成 deleted。清理后仍有残留（删除失败/被重建，或目录名归属失败且目录里
 * 还有他者日志、无法确认代际文件归属）就抛错，由调用方把该 id 记 failed
 * ——宁可报失败，不谎报「已彻底删除」。
 */
export async function removeSessionDirIfOwned(sessionId: string, filePath: string, warn: (message: string) => void): Promise<void> {
  const dir = dirname(filePath);
  if (dir === '' || dir === '.' || dir === '/') return;
  const base = basename(dir);
  const ownedByName = base.includes(sessionId);
  if (!ownedByName) {
    warn(`session-archive: session directory "${base}" does not reference session ${sessionId}; keeping it (layout contract changed?)`);
  }
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return; // 目录已不存在:无残留
    throw new Error(`session-archive: cannot inspect session directory "${base}" for ${sessionId}: ${String(error)}`);
  }
  const ownFile = basename(filePath);
  const otherLogs = entries.filter((entry) => entry !== ownFile && !isGenerationFile(entry)
    && (entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zstd')));
  if (!ownedByName) {
    // 目录名归属校验失败：不递归删目录。只有在目录里没有他者日志时，才能
    // 把代际命名族文件视为本会话残留（一会话一目录假设）；有他者日志时
    // 归属无法确认，fail-closed。
    if (otherLogs.length > 0) {
      throw new Error(`session-archive: cannot confirm stale file ownership in "${base}" for ${sessionId} (other session logs: ${otherLogs.join(', ')})`);
    }
    const residue = await clearGenerationResidue(dir, ownFile, warn);
    if (residue.length > 0) {
      throw new Error(`session-archive: stale session files remain for ${sessionId} in "${base}": ${residue.join(', ')}`);
    }
    return;
  }
  if (otherLogs.length > 0) {
    // 目录里躺着别的会话日志：目录保留（防递归多删），但本会话的代际残留
    // 仍要逐个清掉，否则「已彻底删除」的会话数据还留在磁盘上。
    warn(`session-archive: session directory "${base}" holds other session logs; keeping it`);
    const residue = await clearGenerationResidue(dir, ownFile, warn);
    if (residue.length > 0) {
      throw new Error(`session-archive: stale session files remain for ${sessionId} in "${base}": ${residue.join(', ')}`);
    }
    return;
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
export function limitedConcurrency<T>(limit: number, tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  const results = new Array<T>(tasks.length);
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

/** 从一条消息提取纯文本（text 块拼接；若仅含工具调用则提供占位摘要，忽略图片块）。
 * 官方 Message.content 是 ContentBlock[]，这里优先取 type:'text' 的块。 */
export function messageText(content: unknown, maxChars: number): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  const toolNames: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        text += b.text;
        if (text.length > maxChars) break;
      } else if (b.type === 'tool_use' || b.type === 'tool_call') {
        // OpenAI 兼容形态把名字放在 function.name；官方 native 形态在 b.name。
        const fn = b.function !== null && typeof b.function === 'object'
          ? b.function as Record<string, unknown>
          : undefined;
        toolNames.push(typeof b.name === 'string' ? b.name : typeof fn?.name === 'string' ? fn.name : 'tool');
      }
    }
  }
  if (text.length === 0 && toolNames.length > 0) {
    text = `[${toolNames.join(', ')}]`;
  }
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}
