/**
 * session-archive — 归档会话管理插件（@chaoset/session-archive）
 *
 * 补上 DSH 缺失的"归档"后半程：web 侧边栏新增"归档"面板，可查看归档
 * 会话（列表 + 会话内容只读浏览）、一次多选批量恢复归档（unarchive，
 * 会话回到会话树原位置）或彻底删除归档（删除持久化文件与归档记录）。
 *
 * host 端全部逻辑基于官方 service 接口（workspaceRegistry /
 * sessionPersistence / sessions），不依赖 dsh 内部实现：
 *   1. list()       — archivedSessionIds ∩ sessionPersistence.list()，
 *                     每条附带标题（从事件流折叠 session/title）、目录、
 *                     创建时间、最后修改时间（文件 mtime）、体积与
 *                     live 状态（会话仍在内存中运行时禁止删除）。
 *                     兼容两条宿主线的持久化枚举形状：0.1.2 返回
 *                     SessionHeader[]，0.1.3+ 返回
 *                     SessionPersistenceSnapshot[]（header 在 .header 上）。
 *   2. detail(id)   — 只读会话事件流（标题 + 文本消息 user/assistant），
 *                     供面板"查看"展开；0.1.2 走 readFrom，0.1.3+ 走
 *                     open(id,'read') 句柄（readFrom 已从契约移除）。
 *   3. delete(ids)  — 批量彻底删除：live 会话拒绝；逐个删除持久化文件
 *                     （locate() 定位）+ 会话目录。删除后**保留**该会话在
 *                     归档集合中的 ghost id（不调用移除）：宿主的
 *                     archiveSession 只改归档注册表、不停止内存会话，web
 *                     客户端重连还会把旧 tab 恢复进内存——删除时若把 id
 *                     移出归档集合，仍挂在内存里的会话会因"不再归档"而
 *                     立刻重新出现在侧边栏对话列表（效果等同"恢复"）。
 *                     保留 ghost id 后由 list() 的存在性过滤隐藏，归档面板
 *                     与侧边栏都不会再显示该会话。
 *   4. unarchive(ids) — 批量恢复：仅从归档集合移除**仍存在持久化文件**的
 *                     会话 id（文件已删的 ghost id 拒绝恢复，防止已彻底
 *                     删除的会话"复活"回侧边栏）；会话数据不动。
 *
 * 归档集合（workspaceRegistry.archivedSessionIds）的写入没有官方 API，
 * 这里复用 registry 自身的串行化写入通道（enqueueOperation → requireState
 * → setState，与 archiveSession 相同的路径）；若 registry 内部形状变化，
 * 自动降级为"仅删文件"，归档列表会以存在性过滤幽灵 id，功能仍正确。
 *
 * 本文件不依赖任何 dsh 内部包（纯 ESM + ctx.* service），可独立安装。
 */

import { readdir, stat, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createConfigStore } from './config-store.js';

// remote 服务（侧边栏面板 UI 的读写）可选：typert-protocol 不可用时
// 动态 import 失败，仅面板不可用，host 逻辑不注册（无其他消费者）。
let SessionArchiveGateway: any = null;
try {
  ({ SessionArchiveGateway } = await import('./remote.js'));
} catch (error) {
  console.warn('session-archive: remote gateway unavailable: ' + ((error as Error)?.message ?? String(error)));
}

export const name = 'session-archive';

/** sessions 参与 inject：删除前必须能查询 live 会话（存在即拒绝删除）。 */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'sessions'];

/** 「最近有写入」的判定窗口：内存中的会话 60s 内写过文件即视为忙碌
 * （生成流可能把半截日志 append 回刚删的路径）。 */
const BUSY_WRITE_WINDOW_MS = 60_000;
/** 复验前的沉降等待：活跃写入方重建路径的典型间隔。 */
const REAPPEAR_SETTLE_MS = 300;

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
async function removeSessionDirIfOwned(sessionId: string, filePath: string, warn: (message: string) => void): Promise<void> {
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

/** 默认配置。apply 时与 YAML 传入的 config 合并（cordis 不合并小写 config 导出）。 */
const DEFAULT_CONFIG = {
  /** detail() 返回的最大消息条数（超出仅计数）。 */
  detailMaxMessages: 200,
  /** 每条消息预览的最大字符数（超出截断加省略号）。 */
  messagePreviewChars: 2000,
  /** list() 时并发读取标题的最大并行数。 */
  titleReadConcurrency: 4,
};

export const config = { ...DEFAULT_CONFIG };

/** 配置校验：只接受正整数数值字段，避免脏配置拖垮并发/截断逻辑。 */
function validateConfig(partial: any) {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    throw new TypeError('session-archive config must be a plain object');
  }
  for (const key of ['detailMaxMessages', 'messagePreviewChars', 'titleReadConcurrency']) {
    if (partial[key] !== undefined && (!Number.isInteger(partial[key]) || partial[key] <= 0)) {
      throw new TypeError(`session-archive config field "${key}" must be a positive integer`);
    }
  }
}

/** 配置归一化：非法/缺失数值回退默认值，保证运行时不会拿到 NaN/负数。 */
function normalizeConfig(source: any, defaults: any = DEFAULT_CONFIG): Record<string, any> {
  const raw = source !== null && typeof source === 'object' && !Array.isArray(source) ? source : {};
  const merged = { ...defaults, ...raw };
  const positiveInt = (value: any, fallback: any) => Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    detailMaxMessages: positiveInt(merged.detailMaxMessages, defaults.detailMaxMessages),
    messagePreviewChars: positiveInt(merged.messagePreviewChars, defaults.messagePreviewChars),
    titleReadConcurrency: positiveInt(merged.titleReadConcurrency, defaults.titleReadConcurrency),
  };
}

/**
 * 从持久化枚举项取会话头。dsh 0.1.3 起 `sessionPersistence.list()` 返回
 * `SessionPersistenceSnapshot[]`（`{ header, revision, sizeBytes }`），
 * 0.1.2 及更早返回 `SessionHeader[]`。旧代码直接读 `item.id`，在新宿主上
 * 全是 undefined —— 归档 id 一个也匹配不上，面板恒空（这正是"归档列表
 * 显示不出来"的直接成因）。这里归一成 header，两线都正确。
 */
function headerOf(entry: any): any {
  if (entry === null || entry === undefined || typeof entry !== 'object') return entry;
  return entry.header !== undefined && entry.header !== null ? entry.header : entry;
}

/**
 * 读取一个会话的完整事件流，附带头信息。dsh 0.1.3 的持久化契约移除了
 * `readFrom`（连带抽象类上的 `locate`），读事件流必须 open 一个 read 句柄
 * 再 read(0)，用完 close（不 close 会漏句柄）；头从句柄上取。旧 `readFrom`
 * 仍在时优先用旧的；两条宿主线都覆盖。
 */
async function readSession(persistence: any, sessionId: string): Promise<{ header: any; events: any[] }> {
  if (typeof persistence.readFrom === 'function') {
    const { meta, events } = await persistence.readFrom(sessionId, 0);
    return { header: meta, events };
  }
  const handle = await persistence.open(sessionId, 'read');
  try {
    const { events } = await handle.read(0);
    return { header: handle.header, events };
  } finally {
    await handle.close();
  }
}

/** 并发限制器：最多 N 个任务并行，其余排队。 */
function limitedConcurrency(limit: number, tasks: Array<() => Promise<any>>): Promise<any[]> {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const at = cursor++;
      const task = tasks[at]!;
      results[at] = await task();
    }
  });
  return Promise.all(workers).then(() => results);
}

/** 从事件流折叠最新会话标题（与 dsh-session-title 相同的折叠规则）。 */
function foldTitle(events: any[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && event.type === 'session/title') {
      const title = event.data && typeof event.data.title === 'string' ? event.data.title.trim() : '';
      return title.length > 0 ? title : null;
    }
  }
  return null;
}

/** 从一条消息（Message 结构）提取纯文本（text 块拼接，忽略图片/工具块）。 */
function messageText(message: any, maxChars: number): string {
  if (!message || !Array.isArray(message.content)) return '';
  let text = '';
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
      if (text.length > maxChars) break;
    }
  }
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

/**
 * 构造归档管理 host 逻辑（绑定 ctx 与配置）。
 * 只读操作失败各自容错：单个会话的标题/详情读取失败不拖垮列表。
 */
export function createArchiveHost(ctx: Context, cfg: Record<string, any>) {
  const registry = ctx.workspaceRegistry;
  const persistence = ctx.sessionPersistence;

  /** 当前归档集合快照。 */
  const archivedSet = (): Set<string> => new Set(
    typeof registry.archivedSessionIds === 'function'
      ? registry.archivedSessionIds()
      : (Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : []),
  );

  /** 会话是否"活跃"（不能安全删除）。
   * 宿主的 archiveSession 只改归档注册表、不停止内存会话，web 客户端
   * 重连还会把旧 tab 恢复进内存——归档会话因此长期"内存存在"。但归档
   * 会话已从会话列表移除、无法继续对话，不会再写持久化文件，删除安全；
   * 若把内存存在当作 live，归档面板会永远显示"运行中"且无法勾选删除。
   * 因此 live 仅对"内存存在且**未归档**"的会话为真（防将来误用），
   * 归档面板中恒为 false。 */
  const isLive = (sessionId: string) =>
    ctx.sessions.get(sessionId) !== undefined && !archivedSet().has(sessionId);

  /** 归档瞬间的生成流兜底：会话仍在内存且文件最近有写入（60s 内）时
   * 视为忙碌——删除文件后进行中的请求会把半截日志 append 回来。 */
  const isBusy = (sessionId: string, file: { mtimeMs: number }) =>
    ctx.sessions.get(sessionId) !== undefined && Date.now() - file.mtimeMs < BUSY_WRITE_WINDOW_MS;

  /** 从归档集合移除若干 id（恢复用；删除不调用——见 deleteArchived），返回实际移除的 id。
   * confirm 在 registry 写锁临界区内逐个复核 id 是否仍可恢复（文件仍存在）:
   * 存在性检查放在锁外的话,并发 deleteArchived 可在检查与移除之间删掉文件,
   * 结果"文件没了、归档标记也没了",内存中的会话立刻重回侧边栏。 */
  async function removeFromArchiveSet(ids: string[], confirm?: (sessionId: string) => Promise<boolean>): Promise<string[]> {
    const set = new Set(ids);
    const canWrite =
      registry !== undefined &&
      typeof registry.enqueueOperation === 'function' &&
      typeof registry.requireState === 'function' &&
      typeof registry.setState === 'function';
    if (!canWrite) return []; // 降级：仅删文件，列表按存在性过滤幽灵 id
    let removedIds: string[] = [];
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      const current = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : [];
      let eligible = current.filter((id) => set.has(id));
      if (confirm !== undefined) {
        const confirmed = [];
        for (const id of eligible) {
          try { if (await confirm(id)) confirmed.push(id); } catch {}
        }
        eligible = confirmed;
      }
      removedIds = eligible;
      // 只有真正移除的 id 才离开归档集合;未通过复核的保持原状(仍是 ghost
      // 或正常归档),不能因为请求过就一并抹掉。
      const removedSet = new Set(removedIds);
      const remaining = current.filter((id) => !removedSet.has(id));
      if (removedIds.length > 0) await registry.setState({ ...state, archivedSessionIds: remaining });
    });
    return removedIds;
  }

  /** 归档会话的文件定位结果。
   * located：拿到物理路径（path + stat）；absent：定位成功且文件确认不存在
   * （ghost，幂等删除）；unknown：后端没有定位钩子（locate 是 jsonl 后端的
   * 诊断钩子，0.1.3 起不在抽象契约上），既不能确认存在也不能确认缺失。
   * unknown 与 absent 必须区分：删除语义里 absent 是幂等成功、unknown 是
   * "不能谎报成功也不能删错东西"的失败兜底。 */
  type FileStatus =
    | { state: 'located'; path: string; size: number; mtimeMs: number }
    | { state: 'absent' }
    | { state: 'unknown' };

  /**
   * 解析会话目录里的实际日志文件。locate() 只按当前格式版本拼文件名
   * （如 session.v2.jsonl.zstd），而历史上落盘的可能是旧代际名
   * （session.jsonl / session.v1.jsonl…，0.1.5 的代际解析把 v0 起全部
   * 视为合法代际）——stat 落空不等于会话不存在。官方布局是"一会话一
   * 目录"，目录路径不随代际变化，因此在 locate 给出的目录里扫描
   * session*.jsonl(.zstd) 取实际文件（多个代际并存时取最新 mtime）。
   * 扫描结果为空才认定文件不存在。
   */
  async function resolveGenerationFile(dir: string): Promise<string | null> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return null; // 目录不存在：无任何代际文件
    }
    let latest: { path: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      if (!entry.startsWith('session.') || !(entry.endsWith('.jsonl') || entry.endsWith('.jsonl.zstd'))) continue;
      const candidate = join(dir, entry);
      try {
        const info = await stat(candidate);
        if (latest === null || info.mtimeMs > latest.mtimeMs) latest = { path: candidate, mtimeMs: info.mtimeMs };
      } catch {} // 竞态消失的条目跳过
    }
    return latest?.path ?? null;
  }

  async function fileInfo(header: any): Promise<FileStatus> {
    try {
      if (typeof persistence.locate !== 'function') return { state: 'unknown' };
      const location = persistence.locate(header);
      if (location === undefined || location === null || typeof location.path !== 'string' || location.path.length === 0) {
        return { state: 'unknown' };
      }
      // 先试 locate 的当前代际路径，落空再扫会话目录里的实际代际文件。
      const candidatePaths = [location.path];
      const generation = await resolveGenerationFile(dirname(location.path));
      if (generation !== null) candidatePaths.unshift(generation);
      for (const candidate of candidatePaths) {
        try {
          const info = await stat(candidate);
          return { state: 'located', path: candidate, size: info.size, mtimeMs: info.mtimeMs };
        } catch {} // ENOENT 或竞态：试下一个候选
      }
      return { state: 'absent' };
    } catch {
      return { state: 'absent' };
    }
  }

  /** ghost 分支的孤儿探测:不经持久化枚举,直接 locate({id}) + stat 判断文件
   * 是否实际存在(persistence.list() 会静默跳过首行损坏的日志,"枚举不到"
   * 不等于"文件不存在")。cwd 未知的 ghost id 只能探到缺省位置(_no-cwd 一类),
   * 尽力而为;locate 指向的当前代际名落空时同样扫目录里的实际代际文件。
   * 返回存在的路径;'absent' 确认不存在;无法定位返回 'unknown'。 */
  async function probeOrphanFile(sessionId: string): Promise<string | 'absent' | 'unknown'> {
    try {
      if (typeof persistence.locate !== 'function') return 'unknown';
      const location = persistence.locate({ id: sessionId });
      if (location === undefined || location === null || typeof location.path !== 'string' || location.path.length === 0) {
        return 'unknown';
      }
      try {
        await stat(location.path);
        return location.path;
      } catch {}
      return await resolveGenerationFile(dirname(location.path)) ?? 'absent';
    } catch {
      return 'absent';
    }
  }

  /** 删除后的复验:先等 settleMs 给进行中的写入留出落盘时间,再确认文件没有
   * 被宿主 materialize 的 mkdir -p 整体重建(stat 任意失败——含 ENOENT——都
   * 视为已消失)。返回 true 表示文件仍在(重现)。 */
  async function filePresentAfterSettle(path: string, settleMs: number): Promise<boolean> {
    if (settleMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 单个归档会话的展示行。标题读取失败回退 null（面板显示目录名）。
   * 标题按 mtime 缓存：readSession 会解析整条事件流，而面板关闭态的徽标
   * 轮询每 5 秒打一次 list——不缓存的话就是"读整本会话只为取一行标题"的
   * 持续开销。mtime 不变即命中缓存；文件不可定位（无 locate 的宿主后端）
   * 时跳过缓存直接读，标题仍然可得。 */
  const titleCache = new Map<string, { mtimeMs: number; title: string | null }>();
  async function rowFor(sessionId: string, header: any) {
    const file = await fileInfo(header);
    const located = file.state === 'located' ? file : null;
    let title = null;
    if (located !== null) {
      const cached = titleCache.get(sessionId);
      if (cached !== undefined && cached.mtimeMs === located.mtimeMs) {
        title = cached.title;
      } else {
        try {
          title = foldTitle((await readSession(persistence, sessionId)).events);
        } catch {}
        titleCache.set(sessionId, { mtimeMs: located.mtimeMs, title });
      }
    } else {
      try {
        title = foldTitle((await readSession(persistence, sessionId)).events);
      } catch {}
    }
    return {
      sessionId,
      title,
      cwd: header.cwd ?? null,
      createdAt: header.createdAt,
      updatedAt: located !== null ? located.mtimeMs : header.createdAt,
      size: located !== null ? located.size : 0,
      live: isLive(sessionId),
    };
  }

  return {
    /** 归档会话计数（存在性过滤后的真实数量）。侧边栏徽标的关闭态轮询
     * 只调这里：persistence.list() 只读每个文件的首行头，比 list() 的
     * 全事件流解析便宜一个数量级以上。 */
    async count() {
      const archived = [...archivedSet()];
      if (archived.length === 0) return { count: 0 };
      const snapshots = await persistence.list();
      const persisted = new Set(snapshots.map((entry: any) => headerOf(entry)?.id));
      let count = 0;
      for (const sessionId of archived) if (persisted.has(sessionId)) count++;
      return { count };
    },

    /** 列出全部归档会话（存在性过滤：文件已删的幽灵归档记录不显示）。 */
    async list() {
      const archived = [...archivedSet()];
      if (archived.length === 0) return { items: [] };
      const snapshots = await persistence.list();
      const byId = new Map<string, any>(snapshots.map((entry: any) => [headerOf(entry)?.id, headerOf(entry)] as [string, any]));
      const rows: Array<{ sessionId: string; header: any }> = [];
      for (const sessionId of archived) {
        const header = byId.get(sessionId);
        if (header === undefined) continue; // 幽灵 id：会话文件已不存在
        rows.push({ sessionId, header });
      }
      const items = await limitedConcurrency(cfg.titleReadConcurrency, rows.map(({ sessionId, header }) => () => rowFor(sessionId, header)));
      return { items };
    },

    /** 读取一个归档会话的只读详情（标题 + 文本消息）。仅归档会话可读：
     * detail 是对外暴露的远程端点,不校验成员资格就能读到任意未归档会话。 */
    async detail(sessionId: string) {
      if (!archivedSet().has(sessionId)) {
        throw Object.assign(new Error('session not archived: ' + sessionId), { code: 'NOT_ARCHIVED' });
      }
      const { header: meta, events } = await readSession(persistence, sessionId);
      const title = foldTitle(events);
      const messages = [];
      let totalMessageCount = 0;
      for (const event of events) {
        if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
        // 达到上限后只计数、不再提取文本:截断语义要如实上报,尾部消息也不必
        // 做字符串拼接(大日志下这部分是纯浪费)。
        if (messages.length >= cfg.detailMaxMessages) {
          totalMessageCount++;
          continue;
        }
        const text = messageText(event.data, cfg.messagePreviewChars);
        if (text.length === 0) continue;
        messages.push({
          role: event.type === 'user/message' ? 'user' : 'assistant',
          text,
          time: event.time,
        });
        totalMessageCount++;
      }
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
        live: isLive(sessionId),
      };
    },

    /**
     * 批量彻底删除归档会话。live 会话拒绝（先停止再删）；每个会话删除
     * 持久化文件与会话目录。删除后**不**从归档集合移除 id（保留 ghost id）：
     * 归档不停止内存会话，一旦把 id 移出归档集合，侧边栏（以"不在归档
     * 集合中"作为显示条件）会立刻把仍在内存中的会话重新显示出来，等同
     * "恢复"。ghost id 由 list() 的存在性过滤隐藏，面板与侧边栏均不再
     * 显示该会话；`removedFromArchive` 因此恒为 0。
     *
     * 失败语义（failed[].reason）：'not-archived' 非归档成员；'live' 内存
     * 未归档会话；'busy' 归档会话 60s 内仍有写入；'unenumerable' 文件存在
     * 但持久化枚举不到（首行损坏的孤儿）；'reappeared' 删除后被生成流重建、
     * 二次删除仍压不掉；其余为底层删除错误消息。
     */
    async deleteArchived(sessionIds: string[]) {
      const unique = [...new Set(sessionIds)];
      const deleted = [];
      const failed = [];
      // 归档成员前置校验:persistence.list() 含所有持久化会话而非仅归档
      // 会话,不校验的话任何"未归档、不在内存"的会话 id 都会绕过 live/busy
      // 两道保护被不可逆物理删除。
      const archived = archivedSet();
      const snapshots = await persistence.list();
      const headersById = new Map(snapshots.map((item: any) => [headerOf(item)?.id, headerOf(item)]));
      for (const sessionId of unique) {
        if (!archived.has(sessionId)) {
          failed.push({ sessionId, reason: 'not-archived' });
          continue;
        }
        if (isLive(sessionId)) {
          failed.push({ sessionId, reason: 'live' });
          continue;
        }
        const header = headersById.get(sessionId);
        if (header === undefined) {
          // ghost id(枚举不到)。但"枚举不到 ≠ 文件不存在":首行损坏的日志
          // 会被 persistence.list() 静默跳过,直接当 ghost 报成功会把永远
          // 删不掉的孤儿文件留在磁盘上。先 locate({id}) 探测,探到文件即
          // "有文件但不可枚举",计入 failed 而非谎报成功;定位钩子缺失
          // (unknown)同样不能确认缺失,按不可枚举兜底。
          const orphan = await probeOrphanFile(sessionId);
          if (orphan !== 'absent') {
            failed.push({ sessionId, reason: 'unenumerable' });
            continue;
          }
          // 真不存在:幂等删除(ghost id 保留在归档集合中)。
          deleted.push(sessionId);
          continue;
        }
        const file = await fileInfo(header);
        if (file.state === 'unknown') {
          // 文件存在(枚举得到)但无法定位路径:删不得也不该谎报成功。
          failed.push({ sessionId, reason: 'unlocatable' });
          continue;
        }
        if (file.state === 'absent') {
          deleted.push(sessionId);
          continue;
        }
        if (isBusy(sessionId, file)) {
          failed.push({ sessionId, reason: 'busy' });
          continue;
        }
        try {
          // TOCTOU 复核:isBusy 读的是 stat 快照,检查与 rm 之间生成流可能
          // 恰好落盘;删前重取一次 mtime 再判一次 busy。
          let fresh: { mtimeMs: number } | null = null;
          try { fresh = await stat(file.path); } catch {}
          if (fresh === null) {
            deleted.push(sessionId);
            continue;
          }
          const inMemory = ctx.sessions.get(sessionId) !== undefined;
          if (inMemory && Date.now() - fresh.mtimeMs < BUSY_WRITE_WINDOW_MS) {
            failed.push({ sessionId, reason: 'busy' });
            continue;
          }
          await rm(file.path, { force: true });
          await removeSessionDirIfOwned(sessionId, file.path, (message) => ctx.logger?.warn?.(message));
          // rm 后复验：防宿主 materialize 的 mkdir -p 把路径在删除窗口内重建。
          // 重现只可能来自活跃写入方（内存中的生成流，或刚写完不久、客户端
          // 重连即恢复的 tab）。据此分两档：
          //   - 可能活跃（内存存在 或 60s 内有写入）：维持原 300ms settle 两段
          //     复验；重现则再删一次，仍未删掉计入 failed('reappeared')。
          //   - 冷文件（不在内存且超过 60s 无写入）：未来写入需要用户主动继续
          //     对话，不会落在删除窗口内——做零等待的即时复验即可。批量清理
          //     陈旧归档不再为每个文件白付 2×300ms。
          const plausiblyActive = inMemory || Date.now() - fresh.mtimeMs < BUSY_WRITE_WINDOW_MS;
          const settleMs = plausiblyActive ? REAPPEAR_SETTLE_MS : 0;
          if (await filePresentAfterSettle(file.path, settleMs)) {
            try {
              await rm(file.path, { force: true });
              await removeSessionDirIfOwned(sessionId, file.path, (message) => ctx.logger?.warn?.(message));
            } catch {}
            if (await filePresentAfterSettle(file.path, settleMs)) {
              failed.push({ sessionId, reason: 'reappeared' });
              continue;
            }
          }
          deleted.push(sessionId);
        } catch (error) {
          failed.push({ sessionId, reason: (error as Error)?.message ?? 'delete-failed' });
        }
      }
      return { deleted, failed, removedFromArchive: 0 };
    },

    /**
     * 批量恢复归档会话（仅从归档集合移除，会话数据不动）。只恢复仍存在
     * 持久化文件的会话：文件已删的 ghost id（已彻底删除的会话）拒绝恢复，
     * 避免删除后的会话再次出现在侧边栏对话列表。
     */
    async unarchive(sessionIds: string[]) {
      const unique = [...new Set(sessionIds)];
      const snapshots = await persistence.list();
      const headersById = new Map(snapshots.map((item: any) => [headerOf(item)?.id, headerOf(item)]));
      // 锁外先做一遍廉价过滤(明显不可恢复的直接淘汰),锁内由 confirm 复核,
      // 消除与并发 deleteArchived 的检查-移除窗口。
      const candidates = [];
      for (const sessionId of unique) {
        const header = headersById.get(sessionId);
        if (header === undefined) continue; // 持久化记录已删：拒绝恢复
        candidates.push({ sessionId, header });
      }
      const restored = await removeFromArchiveSet(
        candidates.map(({ sessionId }) => sessionId),
        async (sessionId) => {
          const header = headersById.get(sessionId);
          if (header === undefined) return false;
          const file = await fileInfo(header);
          return file.state === 'located'; // located 才确认文件在：absent 拒绝，unknown 谨慎拒绝
        },
      );
      return { restored, removedFromArchive: restored.length };
    },
  };
}

/** 插件 apply：注册远程服务（面板 UI 读写）。 */
export function apply(ctx: Context, config?: any): any {
  const patchConfig = config || {};
  const cfg = normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig });
  const store = createConfigStore({
    name,
    defaults: DEFAULT_CONFIG,
    patchConfig,
    validate: validateConfig,
    onUpdate: (merged) => {
      Object.assign(cfg, normalizeConfig({ ...DEFAULT_CONFIG, ...patchConfig, ...merged }));
    },
  });
  // 启动时也以 config.json（若有）为权威，和其余插件保持一致。
  Object.assign(cfg, normalizeConfig(store.effective()));

  if (SessionArchiveGateway !== null) {
    ctx.plugin(SessionArchiveGateway, { host: createArchiveHost(ctx, cfg), serviceKey: 'sessionArchive' });
  }
  return store;
}
