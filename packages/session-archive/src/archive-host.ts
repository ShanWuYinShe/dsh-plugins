/**
 * archive-host.ts — 归档 host 工厂：list/count/detail/delete/unarchive 与文件语义。
 *
 * 2026-10-08 从 897 行的 src/index.ts 拆出：扫描助手、配置与 host 工厂各自成
 * 模块，入口只保留网关接线与 apply。
 *
 * @module @chaoset/session-archive/archive-host
 */

import { readdir, stat, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { LocatableSessionPersistence } from './dsh.js'
import { name } from './plugin-config.js'
import {
  BUSY_WRITE_WINDOW_MS,
  REAPPEAR_SETTLE_MS,
  removeSessionDirIfOwned,
  scanSession,
  readTitle,
  delay,
  limitedConcurrency,
  messageText,
} from './session-scan.js'

/**
 * 构造归档管理 host 逻辑（绑定 ctx 与配置）。
 * 只读操作失败各自容错：单个会话的标题/详情读取失败不拖垮列表。
 */
export function createArchiveHost(ctx: Context, cfg: Record<string, any>) {
  /**
   * sessionQuery 标题批量查询的最小结构契约（可选服务，运行时探测）。
   * 官方 SessionTitleObservationResult 的读子集：故意不用官方类型——
   * 服务缺席/降级/契约漂移时靠运行时收窄兜底，加 devDep 只为类型是虚假
   * 安全（且该包不在插件依赖树内）；必填服务才走 dsh.d.ts 官方类型。
   */
  interface TitleBulkValue {
    title?: { title?: unknown };
  }
  interface TitleBulkResult {
    sessionId: string;
    status: string;
    value?: TitleBulkValue;
  }
  const sessionQueryTitles = ((): ((ids: readonly SessionId[]) => Promise<TitleBulkResult[]>) | undefined => {
    // 可选服务必须走 ctx.get：真实 ctx 是 Proxy，未声明 inject 的服务直接
    // 读属性即抛 cannot get property without inject（dsh web 启动实测），
    // 只有 get() 会对缺席服务返回 undefined。极简 ctx 可能连 get 都没有，
    // get 抛错也一样回退——可选探测永远不得连累 host 主逻辑。
    let query: unknown;
    try {
      const get = (ctx as unknown as { get?: (name: string) => unknown }).get;
      query = typeof get === 'function' ? get.call(ctx, 'sessionQuery') : undefined;
    } catch {
      return undefined;
    }
    if (query === null || typeof query !== 'object') return undefined;
    const read = (query as { readTitleSnapshots?: unknown }).readTitleSnapshots;
    if (typeof read !== 'function') return undefined;
    const engine = query as { readTitleSnapshots(ids: readonly SessionId[]): Promise<TitleBulkResult[]> };
    return (ids) => engine.readTitleSnapshots(ids);
  })();
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
   * （删除/恢复一律拒绝）。
   */
  async function snapshotsByIds(ids: readonly string[]): Promise<Map<string, SessionPersistenceSnapshot>> {
    const result = new Map<string, SessionPersistenceSnapshot>();
    if (ids.length === 0) return result;
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
   * 走官方 unarchiveSession。官方方法不做存在性检查、幂等（未归档的 id 直接
   * resolve），因此：
   * - confirm 在调用前逐个复核 id 是否仍可恢复（文件仍存在）；未通过复核
   *   的保持原状（仍是 ghost 或正常归档），不能因为请求过就一并抹掉；
   * - confirm → unarchiveSession 段与 deleteArchived 的删除临界区经
   *   exclusive 互斥（见 exclusive）——官方写入串行只挡住其他归档集合
   *   写入者，挡不住不经过它的删除；
   */
  async function removeFromArchiveSet(ids: string[], confirm?: (sessionId: string) => Promise<boolean>): Promise<string[]> {
    const removedIds: string[] = [];
    for (const sessionId of new Set(ids)) {
      // confirm → 移除与 deleteArchived 的删除临界区互斥（见 exclusive）。
      await exclusive(async () => {
        if (confirm !== undefined) {
          try { if (!(await confirm(sessionId))) return; } catch { return; }
        }
        await registry.unarchiveSession(sessionId as SessionId);
        removedIds.push(sessionId);
      });
    }
    return removedIds;
  }

  /** 归档会话的文件定位结果。
   * located：拿到物理路径（path + stat）；absent：定位成功且文件确认不存在
   * （ghost，幂等删除）；unknown：后端没有定位钩子（locate 是 jsonl 后端的
   * 诊断钩子，不在抽象契约上），既不能确认存在也不能确认缺失。
   * unknown 与 absent 必须区分：删除语义里 absent 是幂等成功、unknown 是
   * "不能谎报成功也不能删错东西"的失败兜底。 */
  type FileStatus =
    | { state: 'located'; path: string; size: number; mtimeMs: number }
    | { state: 'absent' }
    | { state: 'unknown' };

  /**
   * 解析会话目录里的实际日志文件。locate() 只按当前格式版本拼文件名
   * （如 session.v2.jsonl.zstd），而历史上落盘的可能是旧代际名
   * （session.jsonl / session.v1.jsonl…等旧代际名）——stat 落空不等于会话不存在。官方布局是"一会话一
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
  /**
   * 批量读标题（官方标题索引存在时）：O(1)/id，不用 open 整条事件流。
   * 返回 null 表示整单回退直读；Map 缺席的 id 表示该行 rejected，调用方
   * 对该行回退直读。标题语义与直读一致（latest-wins fold，缺标题为 null）。
   *
   * live-preferred 的说明：归档会话已从会话列表移除、无法继续对话，不会
   * 再写持久化文件，内存与文件中的标题必然收敛；展示用标题取 fresher
   * 的一方无害（体积/mtime 等安全关键字段仍以文件为准）。
   */
  async function readTitlesBulk(ids: readonly SessionId[]): Promise<Map<string, string | null> | null> {
    if (sessionQueryTitles === undefined) return null;
    let results: TitleBulkResult[];
    try {
      results = await sessionQueryTitles(ids);
    } catch {
      return null;
    }
    if (!Array.isArray(results)) return null;
    const titles = new Map<string, string | null>();
    for (const result of results) {
      if (result === null || typeof result !== 'object' || result.status !== 'fulfilled') continue;
      const title = result.value?.title?.title;
      titles.set(result.sessionId, typeof title === 'string' ? title : null);
    }
    return titles;
  }

  const TITLE_CACHE_LIMIT = 500;
  const titleCache = new Map<string, { mtimeMs: number; title: string | null }>();
  async function rowFor(sessionId: SessionId, header: SessionHeader, titles: Map<string, string | null> | null) {
    const file = await fileInfo(header);
    const located = file.state === 'located' ? file : null;
    let title: string | null = null;
    if (titles !== null && titles.has(sessionId)) {
      // bulk 命中：索引本就新鲜，跳过缓存与直读。
      title = titles.get(sessionId) ?? null;
    } else if (located !== null) {
      const cached = titleCache.get(sessionId);
      if (cached !== undefined && cached.mtimeMs === located.mtimeMs) {
        title = cached.title;
      } else {
        let readFailed = false;
        try {
          title = await readTitle(persistence, sessionId);
        } catch {
          readFailed = true;
        }
        // 读取失败不写缓存:归档会话文件几乎不再变化,mtime 命中条件会把
        // 一次瞬时 I/O 失败固化为长期"(无标题)"且永不重试。本次回退 null
        //(面板显示目录名),下次轮询自然重试。
        if (!readFailed) {
          if (titleCache.size >= TITLE_CACHE_LIMIT) {
            const oldest = titleCache.keys().next().value;
            if (oldest !== undefined) titleCache.delete(oldest);
          }
          titleCache.set(sessionId, { mtimeMs: located.mtimeMs, title });
        }
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

    /**
     * 批量彻底删除归档会话。live 会话拒绝（先停止再删）；每个会话删除
     * 持久化文件与会话目录。删除后**不**从归档集合移除 id（保留 ghost id）：
     * 归档不停止内存会话，一旦把 id 移出归档集合，侧边栏（以"不在归档
     * 集合中"作为显示条件）会立刻把仍在内存中的会话重新显示出来，等同
     * "恢复"。ghost id 由 list() 的存在性过滤隐藏，面板与侧边栏均不再
     * 显示该会话；`removedFromArchive` 因此恒为 0。
     *
     * 宿主原生的"设置 → 已归档会话"页按"归档集合 JOIN 会话摘要"展示，
     * ghost id 只要内存会话还在就会继续显示（内存消亡无官方 API，只能
     * 随宿主重启）。`needsRestart` 如实返回这类"文件已删、内存仍在"的
     * id，调用方据此提示用户并刷新客户端会话列表（cold 删除即时见效）。
     *
     * 失败语义（failed[].reason）：'not-archived' 非归档成员；'busy' 内存中
     * 的会话日志仍在增长（活跃生成流）；
     * 'unenumerable' 文件存在但持久化枚举不到（首行损坏的孤儿），或无法
     * 确认文件已消失的 ghost id；'reappeared' 删除后被生成流重建、二次
     * 删除仍压不掉；其余为底层删除错误消息。
     */
    async deleteArchived(sessionIds: string[]) {
      const unique = [...new Set(sessionIds)];
      const deleted: string[] = [];
      const failed: Array<{ sessionId: string; reason: string }> = [];
      const needsRestart: string[] = [];
      /** 删除成功记账：文件已删、但内存会话仍在的 id 需要宿主重启才能
       * 从原生"设置 → 已归档会话"页消失，如实返回给调用方提示用户。 */
      const markDeleted = (sessionId: string): void => {
        deleted.push(sessionId);
        if (ctx.sessions.get(sessionId as SessionId) !== undefined) needsRestart.push(sessionId);
      };
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
            // stat 落空 ≠ 会话数据已删:jsonl 后端的格式迁移是"写临时文件 +
            // rename",若迁移恰好落在锁外定位与本次复核之间,旧代际路径已
            // 被 rename 走,而新代际文件仍在同一目录——直接记账会出现"已删
            // 却仍在列表"。复扫目录:扫到实际代际文件就以它为新删除目标;
            // 确实无任何代际文件才认定删除完成(顺带补上目录清理)。
            const migrated = await resolveGenerationFile(dirname(path));
            if (migrated !== null) path = migrated;
            fresh = await stat(path).then(
              (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
              (error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error; },
            );
            if (fresh === null) {
              // 复扫后仍落空(无新代际,或迁移竞态二连/并发他删):按幂等
              // 删除处理,列表的存在性过滤自会隐藏幽灵 id。
              await removeSessionDirIfOwned(sessionId, path, (message) => ctx.logger?.warn?.(message));
              markDeleted(sessionId);
              return;
            }
          }
          // 生成流兜底:内存中的会话且 mtime 在窗口内,沉降观察一次,文件
          // 仍在增长说明活跃写入方在 append(删除后会把半截日志写回来),
          // 拒绝;体积静止则只是一次性落盘/迁移/flush 刷新过 mtime,照删。
          const inMemory = ctx.sessions.get(sessionId as SessionId) !== undefined;
          if (inMemory && Date.now() - fresh.mtimeMs < BUSY_WRITE_WINDOW_MS) {
            const second = await settleStat(path);
            if (second === null) {
              markDeleted(sessionId);
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
          markDeleted(sessionId);
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
        // 无独立的 'live' 检查:本端点只删归档成员,而归档成员按 isLive 的
        // 定义(内存存在且未归档)恒非 live——「内存中仍挂着的归档会话」的
        // 删除保护由 deleteLocatedFile 的 busy 沉降观察承担(活跃生成流会
        // 被增长判定拒绝),不是 live 判定。此前的 'live' 分支在该前置检查
        // 之后永不可达(死代码),已删;词表保留 'busy'/'not-archived'。
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
              markDeleted(sessionId);
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
      return { deleted, failed, removedFromArchive: 0, needsRestart };
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
        try {
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
        } catch {
          // confirm 路径任何意外异常等价于"不可恢复":必须给这个 id 一个
          // failed 下落(reason 复用 not-restorable),否则它既不在 restored
          // 也不在 failed,违反"restored 之外的每个请求 id 都必须有下落"的
          // 约定。fileInfo 自身全路径兜底,此分支当前不可达——防的是宿主
          // 契约漂移时的静默丢失。
          failed.push({ sessionId, reason: 'not-restorable' });
          return false;
        }
      });
      return { restored, failed, removedFromArchive: restored.length };
    },
  };
}
