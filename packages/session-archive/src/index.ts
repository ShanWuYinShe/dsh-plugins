/**
 * session-archive — 归档会话管理插件（@chaoset/session-archive）
 *
 * 补上 DSH 缺失的"归档"后半程：web 侧边栏新增"归档"面板，可查看归档
 * 会话（列表 + 会话内容只读浏览）、一次多选批量恢复归档（unarchive，
 * 会话回到会话树原位置）或彻底删除归档（删除持久化文件与归档记录）。
 *
 * host 端全部逻辑基于官方 service 契约类型（@deepseek-ai/dsh-workspace /
 * dsh-session / dsh-session-persistence / dsh-session-title 的官方 d.ts），
 * 面向 DSH 0.1.6-alpha 宿主线，不保留旧宿主版本兼容：
 *   1. list()       — archivedSessionIds ∩ 逐 id persistence.stat()，
 *                     每条附带标题（官方 foldSessionTitle 折叠，事件流
 *                     分块读取）、目录、创建时间、最后修改时间（文件
 *                     mtime）、体积与 live 状态（会话仍在内存中运行时
 *                     禁止删除）。
 *   2. detail(id)   — open(id,'read') 句柄只读会话事件流（标题 + 文本
 *                     消息 user/assistant），供面板"查看"展开。
 *   3. delete(ids)  — 批量彻底删除：live 会话拒绝；逐个删除持久化文件
 *                     （jsonl 后端的 locate() 定位，落空时按会话目录扫
 *                     实际代际文件）+ 会话目录。删除后**保留**该会话在
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
 * 归档集合（workspaceRegistry.archivedSessionIds）的移除走官方 API
 * unarchiveSession（DSH 0.1.6 新增；此前只有 archiveSession 方向，本插件
 * 曾复用 registry 私有写入通道 enqueueOperation → requireState → setState，
 * 0.1.6 起已删除该 hack）。官方 unarchiveSession 不做存在性检查、内部串行
 * 化写入，因此"文件仍存在"的复核仍由本插件在调用前完成，并与 deleteArchived
 * 经 exclusive 互斥（见下）；若 registry 缺失该方法（旧宿主/残缺 mock），
 * 恢复返回空，归档列表仍以存在性过滤幽灵 id，功能正确。
 *
 * 本文件运行时不依赖任何 dsh 内部包（纯 ESM + ctx.* service + 官方
 * foldSessionTitle 纯函数），可独立安装；官方包仅作为 devDependency 提供
 * 契约类型。
 */

import { readdir, stat, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
} from '@deepseek-ai/dsh-session';
import type { SessionHandle, SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import type { LocatableSessionPersistence } from './dsh.js';
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

/** 「可能活跃」的 mtime 窗口：内存中的会话 60s 内写过文件才值得做增长
 * 观察（生成流可能把半截日志 append 回刚删的路径；窗口外的静默文件无
 * 疑似写入方，直接删）。是否真的忙碌由沉降观察的体积增长判定。 */
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

/** 标题/详情分块读取的块长（事件数，官方契约 read(offset,length) 的上界，
 * 超界返回空数组）。此前 read(0) 一次性物化全部事件：大日志下峰值内存
 * O(整条日志)、同步 JSON.parse 集中在宿主事件循环上，面板打开（并发 4 路
 * 标题读）拖慢的是整个宿主而不只是面板；分块后峰值 O(块)。 */
const READ_CHUNK_EVENTS = 200;

/**
 * 分块遍历一条会话的事件流（升序、全量），每块交给 onChunk 消费后即可弃，
 * 返回句柄上的会话头。用完 close——不 close 会漏句柄。
 */
async function scanSession(persistence: SessionPersistence, sessionId: SessionId, onChunk: (events: readonly SessionEvent[]) => void): Promise<SessionHeader> {
  const handle: SessionHandle = await persistence.open(sessionId, 'read');
  try {
    for (let offset = 0; ; offset += READ_CHUNK_EVENTS) {
      const { events } = await handle.read(offset, READ_CHUNK_EVENTS);
      if (events.length === 0) break;
      onChunk(events);
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
async function readTitle(persistence: SessionPersistence, sessionId: SessionId): Promise<string | null> {
  const titleEvents: SessionEvent[] = [];
  await scanSession(persistence, sessionId, (events) => {
    for (const event of events) {
      if (event.type === 'session/title') titleEvents.push(event);
    }
  });
  return foldSessionTitle(titleEvents)?.title ?? null;
}

/** 等待 ms 毫秒（沉降观察、删除窗口用）。 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 并发限制器：最多 N 个任务并行，其余排队。宽度下限 1——直调
 * createArchiveHost 传 0/负数时若产出 0 个 worker，会静默返回全 undefined
 * 的数组而非报错。 */
function limitedConcurrency(limit: number, tasks: Array<() => Promise<any>>): Promise<any[]> {
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
function messageText(content: unknown, maxChars: number): string {
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

/**
 * 构造归档管理 host 逻辑（绑定 ctx 与配置）。
 * 只读操作失败各自容错：单个会话的标题/详情读取失败不拖垮列表。
 */
export function createArchiveHost(ctx: Context, cfg: Record<string, any>) {
  const registry: WorkspaceRegistry = ctx.workspaceRegistry;
  const persistence: SessionPersistence & LocatableSessionPersistence = ctx.sessionPersistence;

  /** 当前归档集合快照（官方契约：getter 返回只读 SessionId 数组）。 */
  const archivedSet = (): Set<string> => new Set<string>(registry.archivedSessionIds);

  /** 会话是否"活跃"（不能安全删除）。
   * 宿主的 archiveSession 只改归档注册表、不停止内存会话，web 客户端
   * 重连还会把旧 tab 恢复进内存——归档会话因此长期"内存存在"。但归档
   * 会话已从会话列表移除、无法继续对话，不会再写持久化文件，删除安全；
   * 若把内存存在当作 live，归档面板会永远显示"运行中"且无法勾选删除。
   * 因此 live 仅对"内存存在且**未归档**"的会话为真（防将来误用），
   * 归档面板中恒为 false。 */
  const isLive = (sessionId: SessionId) =>
    ctx.sessions.get(sessionId) !== undefined && !archivedSet().has(sessionId);

  /**
   * 批量查一组 id 的持久化快照，返回 Map（只含枚举得到的 id）。
   *
   * 优先逐 id 走官方契约 stat(id)——只读该会话的元数据头，成本 O(项目目录数)/id；
   * 此前四个端点（count/list/delete/unarchive）都用全量 persistence.list()：
   * 枚举实例上**所有**会话（每文件读头）只为挑出几个归档 id，而 count 是
   * 每 5 秒每标签页的徽标轮询端点，实例积累数千历史会话后是持续的全树扫。
   * 枚举不到（stat 返回 undefined 或抛错——jsonl 后端对重复 id 会抛异常）
   * 的 id 不出现在 Map 里，与 list() 时代「不在快照表里」的幽灵语义对齐：
   * list() 同样静默跳过首行损坏的日志；stat 抛错按枚举不到处理方向更保守
   * （删除/恢复一律拒绝）。stat 不在契约上的宿主回退一次全量 list()。
   */
  async function snapshotsByIds(ids: readonly string[]): Promise<Map<string, SessionPersistenceSnapshot>> {
    const result = new Map<string, SessionPersistenceSnapshot>();
    if (ids.length === 0) return result;
    if (typeof (persistence as Partial<SessionPersistence>).stat !== 'function') {
      const wanted = new Set(ids);
      for (const snapshot of await persistence.list()) {
        if (wanted.has(snapshot.header.id) && !result.has(snapshot.header.id)) {
          result.set(snapshot.header.id, snapshot);
        }
      }
      return result;
    }
    await limitedConcurrency(8, ids.map((id) => async () => {
      try {
        const snapshot = await persistence.stat(id as SessionId);
        if (snapshot !== undefined) result.set(id, snapshot);
      } catch {}
    }));
    return result;
  }

  /**
   * 沉降观察：等一个写入沉降窗口后重取文件 stat（null = 文件已消失）。
   * 归档瞬间的生成流兜底用：归档会话会因 web 客户端重连恢复 tab 而长期
   * 挂在宿主内存（SessionStore.get 恒命中），而宿主的批量落盘 timer、
   * write-open 格式迁移、flush 检查点都会在**没有生成**的情况下刷新
   * mtime——只看"内存存在 + mtime 新鲜"会把早已停止的会话永远判成 busy
   * （面板报"请先停止"，用户无流可停）。活跃生成流是持续 append，一个
   * 沉降窗口内体积必然增长；一次性落盘不会。增长与否由调用点对比前后
   * 两次 stat 的 size 判定。
   */
  const settleStat = (path: string): Promise<{ size: number; mtimeMs: number } | null> =>
    delay(REAPPEAR_SETTLE_MS).then(() => stat(path).then(
      (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
      // 只有 ENOENT 才是「文件已消失」:EACCES 等错误下把 null 当已消失会
      // 谎报 deleted;上抛交给删除临界区的 catch 以真实原因计入 failed。
      (error) => { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; },
    ));

  /**
   * delete ↔ unarchive 临界区的互斥串行化（插件闭包内的 promise 链）。
   * 两者的「检查 → 生效」窗口必须互斥，否则并发时会出现两种错位：
   *   - unarchive 的 confirm 看到 located → deleteArchived 随后 rm →
   *     unarchiveSession 仍把 id 移出归档集合：文件没了、归档标记也没了，内存
   *     会话重回侧边栏（等同误恢复）；
   *   - 反向：恢复刚落地，先行发起的删除把新恢复会话的文件清掉。
   * registry 的官方写入 API（archiveSession / unarchiveSession）内部自行
   * 串行化归档集合写入，deleteArchived 不经过它，因此这里自行串行化。
   * delete 的临界区与 unarchive 的 confirm → unarchiveSession 段经本链互斥；
   * 本插件不持有 registry 写锁，只串行化自己的"检查 → 生效"窗口，无循环等待。
   */
  let exclusiveTail: Promise<void> = Promise.resolve();
  function exclusive<T>(section: () => Promise<T>): Promise<T> {
    const run = exclusiveTail.then(section, section);
    exclusiveTail = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 从归档集合移除若干 id（恢复用；删除不调用——见 deleteArchived），返回实际移除的 id。
   *
   * 走官方 unarchiveSession（DSH 0.1.6 的公开契约；0.1.5 时代复用私有写入
   * 通道的 hack 已删除）。官方方法不做存在性检查、幂等（未归档的 id 直接
   * resolve），因此：
   * - confirm 在调用前逐个复核 id 是否仍可恢复（文件仍存在）；未通过复核
   *   的保持原状（仍是 ghost 或正常归档），不能因为请求过就一并抹掉；
   * - confirm → unarchiveSession 段与 deleteArchived 的删除临界区经
   *   exclusive 互斥（见 exclusive）——官方写入串行只挡住其他归档集合
   *   写入者，挡不住不经过它的删除；
   * - registry 缺失该方法（旧宿主/残缺 mock）时返回空：列表按存在性过滤
   *   幽灵 id，功能仍正确。
   */
  async function removeFromArchiveSet(ids: string[], confirm?: (sessionId: string) => Promise<boolean>): Promise<string[]> {
    const unarchiveSession = (registry as WorkspaceRegistry & {
      unarchiveSession?: (sessionId: string) => Promise<void>;
    }).unarchiveSession;
    if (typeof unarchiveSession !== 'function') return []; // 降级：仅删文件，列表按存在性过滤幽灵 id
    const removedIds: string[] = [];
    for (const sessionId of new Set(ids)) {
      // confirm → 移除与 deleteArchived 的删除临界区互斥（见 exclusive）。
      await exclusive(async () => {
        if (confirm !== undefined) {
          try { if (!(await confirm(sessionId))) return; } catch { return; }
        }
        await unarchiveSession.call(registry, sessionId as SessionId);
        removedIds.push(sessionId);
      });
    }
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

  async function fileInfo(header: SessionHeader): Promise<FileStatus> {
    try {
      if (typeof persistence.locate !== 'function') return { state: 'unknown' };
      const location = persistence.locate(header);
      if (location === undefined || typeof location.path !== 'string' || location.path.length === 0) {
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
      // 内层每个 stat 都各自兜底，这里只会接到 locate 抛错（后端异常/契约
      // 漂移）——既不能确认存在也不能确认缺失，必须按 unknown 处理。返回
      // absent 会让 deleteArchived 把它记成"幂等删除成功"（0.3.9 谎报成功
      // 的同源变体）；unknown 对应删除路径的 unlocatable 拒绝。
      return { state: 'unknown' };
    }
  }

  /** 删除后的复验:先等 settleMs 给进行中的写入留出落盘时间,再确认文件没有
   * 被宿主 materialize 的 mkdir -p 整体重建。返回 true 表示文件仍在(重现)。
   * 只有 ENOENT 视为已消失;EACCES 等 stat 错误按「仍在」处理,让上层走
   * 二次删除并以真实错误上报,不谎报 deleted。 */
  async function filePresentAfterSettle(path: string, settleMs: number): Promise<boolean> {
    if (settleMs > 0) await delay(settleMs);
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      return true;
    }
  }

  /** 单个归档会话的展示行。标题读取失败回退 null（面板显示目录名）。
   * 标题按 mtime 缓存：readSession 会解析整条事件流，而面板关闭态的徽标
   * 轮询每 5 秒打一次 list——不缓存的话就是"读整本会话只为取一行标题"的
   * 持续开销。mtime 不变即命中缓存；文件不可定位（无 locate 的宿主后端）
   * 时跳过缓存直接读，标题仍然可得。折叠用官方 foldSessionTitle。
   * 缓存有上限（FIFO 淘汰最旧条目）：已删除会话的条目不再被 mtime 命中
   * 更新，长驻 host 进程下无界累积。 */
  const TITLE_CACHE_LIMIT = 500;
  const titleCache = new Map<string, { mtimeMs: number; title: string | null }>();
  async function rowFor(sessionId: SessionId, header: SessionHeader) {
    const file = await fileInfo(header);
    const located = file.state === 'located' ? file : null;
    let title: string | null = null;
    if (located !== null) {
      const cached = titleCache.get(sessionId);
      if (cached !== undefined && cached.mtimeMs === located.mtimeMs) {
        title = cached.title;
      } else {
        try {
          title = await readTitle(persistence, sessionId);
        } catch {}
        if (titleCache.size >= TITLE_CACHE_LIMIT) {
          const oldest = titleCache.keys().next().value;
          if (oldest !== undefined) titleCache.delete(oldest);
        }
        titleCache.set(sessionId, { mtimeMs: located.mtimeMs, title });
      }
    } else {
      try {
        title = await readTitle(persistence, sessionId);
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
      const items = await limitedConcurrency(cfg.titleReadConcurrency, rows.map(({ sessionId, header }) => () => rowFor(sessionId as SessionId, header)));
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
            event.type === 'user/message' ? event.data.content : event.data.message?.content,
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

    /**
     * 批量彻底删除归档会话。live 会话拒绝（先停止再删）；每个会话删除
     * 持久化文件与会话目录。删除后**不**从归档集合移除 id（保留 ghost id）：
     * 归档不停止内存会话，一旦把 id 移出归档集合，侧边栏（以"不在归档
     * 集合中"作为显示条件）会立刻把仍在内存中的会话重新显示出来，等同
     * "恢复"。ghost id 由 list() 的存在性过滤隐藏，面板与侧边栏均不再
     * 显示该会话；`removedFromArchive` 因此恒为 0。
     *
     * 失败语义（failed[].reason）：'not-archived' 非归档成员；'live' 内存
     * 未归档会话；'busy' 内存中的会话日志仍在增长（活跃生成流）；
     * 'unenumerable' 文件存在但持久化枚举不到（首行损坏的孤儿），或无法
     * 确认文件已消失的 ghost id；'reappeared' 删除后被生成流重建、二次
     * 删除仍压不掉；其余为底层删除错误消息。
     */
    async deleteArchived(sessionIds: string[]) {
      const unique = [...new Set(sessionIds)];
      const deleted: string[] = [];
      const failed: Array<{ sessionId: string; reason: string }> = [];
      // 归档成员前置校验:persistence 覆盖所有持久化会话而非仅归档会话,
      // 不校验的话任何"未归档、不在内存"的会话 id 都会绕过 live/busy
      // 两道保护被不可逆物理删除。快照只 stat 归档成员:非成员在循环里
      // 前置拒绝,不必查持久层。
      const archived = archivedSet();
      const snapshots = await snapshotsByIds(unique.filter((id) => archived.has(id)));

      /** 常规删除流（located 路径），必须在 exclusive 临界区内调用：
       * TOCTOU 复核 → busy 沉降观察 → rm → 重现复验。 */
      const deleteLocatedFile = async (sessionId: string, path: string): Promise<void> => {
        try {
          // TOCTOU 复核:fileInfo 的 stat 是快照,检查与 rm 之间文件可能
          // 恰好变化;rm 前重取一次。只有 ENOENT 才是「已消失」,其余错误
          // 上抛以真实原因计入 failed。
          let fresh: { size: number; mtimeMs: number } | null = await stat(path).then(
            (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
            (error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error; },
          );
          if (fresh === null) {
            deleted.push(sessionId);
            return;
          }
          // 生成流兜底:内存中的会话且 mtime 在窗口内,沉降观察一次,文件
          // 仍在增长说明活跃写入方在 append(删除后会把半截日志写回来),
          // 拒绝;体积静止则只是一次性落盘/迁移/flush 刷新过 mtime,照删。
          const inMemory = ctx.sessions.get(sessionId as SessionId) !== undefined;
          if (inMemory && Date.now() - fresh.mtimeMs < BUSY_WRITE_WINDOW_MS) {
            const second = await settleStat(path);
            if (second === null) {
              deleted.push(sessionId);
              return;
            }
            if (second.size > fresh.size) {
              failed.push({ sessionId, reason: 'busy' });
              return;
            }
            fresh = second;
          }
          await rm(path, { force: true });
          await removeSessionDirIfOwned(sessionId, path, (message) => ctx.logger?.warn?.(message));
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
          if (await filePresentAfterSettle(path, settleMs)) {
            try {
              await rm(path, { force: true });
              await removeSessionDirIfOwned(sessionId, path, (message) => ctx.logger?.warn?.(message));
            } catch (error) {
              // 二次删除失败必须以真实原因上报:吞掉会让 EPERM/EBUSY 被
              // 误标为 reappeared,把排障方向带偏。
              ctx.logger?.warn?.(`session-archive: second delete failed for ${sessionId}: ${String(error)}`);
              failed.push({ sessionId, reason: (error as Error)?.message ?? 'delete-failed' });
              return;
            }
            if (await filePresentAfterSettle(path, settleMs)) {
              failed.push({ sessionId, reason: 'reappeared' });
              return;
            }
          }
          deleted.push(sessionId);
        } catch (error) {
          failed.push({ sessionId, reason: (error as Error)?.message ?? 'delete-failed' });
        }
      };

      for (const sessionId of unique) {
        const id = sessionId as SessionId;
        if (!archived.has(sessionId)) {
          failed.push({ sessionId, reason: 'not-archived' });
          continue;
        }
        if (isLive(id)) {
          failed.push({ sessionId, reason: 'live' });
          continue;
        }
        if (snapshots.get(sessionId) === undefined) {
          // ghost id(枚举不到)。"枚举不到 ≠ 文件不存在":首行损坏的日志会被
          // persistence 静默跳过;而 jsonl 后端按 cwd 分目录,ghost 探测没有
          // header、拿不到 cwd,locate 只能探缺省目录(_no-cwd 一类)——既探
          // 不到真实文件,也确认不了缺失。因此 ghost 一律不能当"已删"报成功
          // (0.3.9 谎报成功的同源变体),计入 failed;ghost id 留在归档集合,
          // 由 list() 的存在性过滤隐藏,面板与侧边栏均不可见。
          failed.push({ sessionId, reason: 'unenumerable' });
          continue;
        }
        const header = snapshots.get(sessionId)!.header;
        const file = await fileInfo(header);
        if (file.state === 'unknown') {
          // 文件存在(枚举得到)但无法定位路径:删不得也不该谎报成功。
          failed.push({ sessionId, reason: 'unlocatable' });
          continue;
        }
        // ── 与 unarchive 的 confirm → unarchiveSession 互斥的删除临界区（exclusive）。
        // rm 及其全部前置判定（含 absent 复核）都在窗口内：unarchive 要么
        // 整体先落地（此处复验归档成员资格失败、拒绝删除），要么整体等删除
        // 完成（confirm 探到 absent、拒绝恢复）——"文件被删的同时归档标记
        // 被移除"的错位不存在。
        if (file.state === 'absent') {
          // absent 不是无脑幂等成功:fileInfo 的目录扫描是快照,宿主格式
          // 迁移（写临时文件+rename）的瞬间目录可能扫空,报已删前锁内重扫
          // 一次;重扫发现文件在,转常规删除流。
          await exclusive(async () => {
            if (!archivedSet().has(sessionId)) {
              failed.push({ sessionId, reason: 'not-archived' });
              return;
            }
            const fresh = await fileInfo(header);
            if (fresh.state === 'unknown') {
              failed.push({ sessionId, reason: 'unlocatable' });
              return;
            }
            if (fresh.state === 'absent') {
              deleted.push(sessionId);
              return;
            }
            await deleteLocatedFile(sessionId, fresh.path);
          });
          continue;
        }
        await exclusive(async () => {
          // 归档成员锁内复验:快照之后、删除之前,unarchive 可能已把 id 移出
          // 集合——删除先行发起也不能清掉刚恢复的会话文件。
          if (!archivedSet().has(sessionId)) {
            failed.push({ sessionId, reason: 'not-archived' });
            return;
          }
          await deleteLocatedFile(sessionId, file.path);
        });
      }
      return { deleted, failed, removedFromArchive: 0 };
    },

    /**
     * 批量恢复归档会话（仅从归档集合移除，会话数据不动）。只恢复仍存在
     * 持久化文件的会话：文件已删的 ghost id（已彻底删除的会话）拒绝恢复，
     * 避免删除后的会话再次出现在侧边栏对话列表。
     *
     * 与 delete 对称的失败语义（failed[].reason）：'not-archived' 非归档
     * 成员；'unenumerable' 持久化枚举不到（文件已删/首行损坏）；其余为
     * confirm 复核淘汰（'not-restorable'）或底层错误消息。restored 之外的
     * 每个请求 id 都必须在 failed 里有下落——客户端据此把「已恢复 0 个」
     * 渲染为失败而非成功。
     */
    async unarchive(sessionIds: string[]) {
      const unique = [...new Set(sessionIds)];
      const archived = archivedSet();
      const snapshots = await snapshotsByIds(unique.filter((id) => archived.has(id)));
      const failed: Array<{ sessionId: string; reason: string }> = [];
      // 锁外先做一遍廉价过滤(明显不可恢复的直接淘汰),锁内由 confirm 复核,
      // 消除与并发 deleteArchived 的检查-移除窗口。
      const candidates: string[] = [];
      for (const sessionId of unique) {
        if (!archived.has(sessionId)) {
          failed.push({ sessionId, reason: 'not-archived' });
          continue;
        }
        if (snapshots.get(sessionId) === undefined) {
          failed.push({ sessionId, reason: 'unenumerable' }); // 持久化记录已删：拒绝恢复
          continue;
        }
        candidates.push(sessionId);
      }
      const restored = await removeFromArchiveSet(candidates, async (sessionId) => {
        const snapshot = snapshots.get(sessionId);
        if (snapshot === undefined) return false;
        const file = await fileInfo(snapshot.header);
        if (file.state !== 'located') {
          // located 才确认文件在:absent(快照后文件消失)/unknown(无法确认)
          // 谨慎拒绝,并如实计入 failed。
          failed.push({ sessionId, reason: 'not-restorable' });
          return false;
        }
        return true;
      });
      return { restored, failed, removedFromArchive: restored.length };
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
