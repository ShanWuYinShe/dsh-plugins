/**
 * archive-host-context.ts — 归档 host 的内部上下文（助手与共享状态）。
 *
 * 2026-10-08 从 663 行的 archive-host.ts 拆出：内部助手（会话快照、文件定位、标题
 * 批量读取、串行互斥、代际文件扫描）与五个对外方法原本在一个闭包里。现在助手收进
 * 本模块返回的 deps 对象，queries / mutations 两个子工厂顶部解构后方法体逐字不动。
 *
 * @module @chaoset/session-archive/archive-host-context
 */

import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
// sessionQuery 官方类型不再在本模块出现：可选服务的探测与契约收敛在
// session-query-bridge.ts，本模块只消费它导出的自有最小契约
// （SessionQueryTitles）。官方 d.ts 漂移不会再渗进 host 上下文。
import { resolveSessionQueryTitles } from './session-query-bridge.js'
import type { SessionQueryTitles } from './session-query-bridge.js'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { LocatableSessionPersistence } from './dsh.js'
import { name } from './plugin-config.js'
import { REAPPEAR_SETTLE_MS, readTitle, delay, limitedConcurrency } from './session-scan.js'
import type { Context } from '@deepseek-ai/cordis'

export function createHostContext(ctx: Context, cfg: Record<string, any>) {
  /**
   * sessionQuery 标题批量查询（可选服务，运行时探测）。
   * 探测与契约见 session-query-bridge.ts：命中时返回批量读函数，
   * 服务缺席/形状不符/探测抛错时为 undefined。
   * 服务缺席或整单失败时 readTitlesBulk 返回 null，逐行回退直读。
   */
  // get 先绑到局部再传：ctx 可能是极简对象（连 get 都没有），
  // 桥内自行兜底，不在调用点判空以保持探测语义单点。
  const ctxGet = (ctx as { get?: unknown }).get;
  const sessionQueryTitles: SessionQueryTitles | undefined =
    typeof ctxGet === 'function' ? resolveSessionQueryTitles(ctxGet.bind(ctx)) : undefined;
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
    // 桥的契约只承诺「一组观测结果」，逐项形状仍按官方语义在这里防御性读取
    // （整单抛错 → null 全量回退；单行 rejected/异形 → 该行缺席 Map → 逐行回退）。
    let results: readonly unknown[];
    try {
      results = await sessionQueryTitles(ids);
    } catch {
      return null;
    }
    if (!Array.isArray(results)) return null;
    const titles = new Map<string, string | null>();
    for (const entry of results) {
      const result = entry as { status?: unknown; sessionId?: unknown; value?: { title?: { title?: unknown } } } | null;
      if (result === null || typeof result !== 'object' || result.status !== 'fulfilled') continue;
      if (typeof result.sessionId !== 'string') continue;
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
    ctx,
    cfg,
    persistence,
    archivedSet,
    isLive,
    snapshotsByIds,
    settleStat,
    exclusive,
    removeFromArchiveSet,
    resolveGenerationFile,
    fileInfo,
    filePresentAfterSettle,
    readTitlesBulk,
    rowFor,
  }
}

/** 上下文对象：见 createHostContext（含五个方法需要的全部助手与共享状态）。 */
export type HostContext = ReturnType<typeof createHostContext>
