/**
 * archive-host-context.ts — 远程服务的内部依赖装配（deps：助手与共享状态）。
 *
 * 从 663 行的 host 模块拆出：内部助手（会话快照、文件定位、标题批量读取、
 * 串行互斥、代际文件扫描）与五个对外方法原本在一个闭包里。SA-08 起五个
 * 能力方法整体搬进 remote.ts 的 SessionArchiveGateway，本模块只返回 deps
 * 对象（不对外暴露方法），供 Gateway 构造期装配。
 *
 * @module @chaoset/session-archive/archive-host-context
 */

import { lstat, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
// sessionQuery 官方类型不再在本模块出现：可选服务的探测与契约收敛在
// session-query-bridge.ts，本模块只消费它导出的自有最小契约
// （SessionQueryTitles）。官方 d.ts 漂移不会再渗进 host 上下文。
import { resolveSessionQueryTitles } from './session-query-bridge.js'
import type { SessionQueryTitles } from './session-query-bridge.js'
import { resolveCachedArchiveTitle } from './session-projection-bridge.js'
import type { CachedArchiveTitle } from './session-projection-bridge.js'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { name } from './plugin-config.js'
import type { SessionArchiveConfig } from './plugin-config.js'
import { readTitle, limitedConcurrency } from './session-scan.js'
import type { ArchiveListRow } from './types.js'
import type { Context } from '@deepseek-ai/cordis'

/** 批量 stat 快照的并发宽度（本地文件元数据读，8 路足够摊薄目录遍历成本）。 */
const SNAPSHOT_CONCURRENCY = 8

/** 文件 stat 的最小测试缝：仅供测试构造「删除后被重建」的确定性窗口。
 * 生产路径永远用 node:fs/promises 的 stat（默认值）。 */
export type StatFile = (path: string) => Promise<{ size: number; mtimeMs: number }>

const defaultStatFile: StatFile = (path) => stat(path)

export function createHostContext(ctx: Context, cfg: SessionArchiveConfig, statFile: StatFile = defaultStatFile) {
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
  /** 官方持久化 projection 缓存（可选服务，运行时探测）。
   * 归档列表的标题正常情况下全部由它零 I/O 提供——sessionQuery 的批量标题
   * 对 cold 会话其实是逐条整读日志，不能当索引用（见 archivedRows）。 */
  const readCachedTitle: CachedArchiveTitle | undefined =
    typeof ctxGet === 'function' ? resolveCachedArchiveTitle(ctxGet.bind(ctx)) : undefined;
  const registry: WorkspaceRegistry = ctx.workspaceRegistry;
  const persistence: SessionPersistence = ctx.sessionPersistence;

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
  async function snapshotsByIds(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, SessionPersistenceSnapshot>> {
    const result = new Map<string, SessionPersistenceSnapshot>();
    if (ids.length === 0) return result;
    await limitedConcurrency(SNAPSHOT_CONCURRENCY, ids.map((id) => async () => {
      try {
        const snapshot = await persistence.stat(id as SessionId, { signal });
        if (snapshot !== undefined) result.set(id, snapshot);
      } catch (error) {
        // 取消不是「枚举不到」：必须上抛，让 Gateway 按 gateway/cancelled 呈现。
        if (signal?.aborted === true) throw signal.reason ?? error;
      }
    }), signal);
    return result;
  }

  /**
   * delete ↔ unarchive 临界区的互斥串行化（插件闭包内的 promise 链）。
   * 两者的「检查 → 生效」窗口必须互斥，否则并发时会出现两种错位：
   *   - unarchive 的 confirm 看到 located → delete() 随后 rm →
   *     unarchiveSession 仍把 id 移出归档集合：文件没了、归档标记也没了，内存
   *     会话重回侧边栏（等同误恢复）；
   *   - 反向：恢复刚落地，先行发起的删除把新恢复会话的文件清掉。
   * registry 的官方写入 API（archiveSession / unarchiveSession）内部自行
   * 串行化归档集合写入，delete() 不经过它，因此这里自行串行化。
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
   * 从归档集合移除若干 id（恢复用；删除不调用——见 delete），返回实际移除的 id。
   *
   * 走官方 unarchiveSession。官方方法不做存在性检查、幂等（未归档的 id 直接
   * resolve），因此：
   * - confirm 在调用前逐个复核 id 是否仍可恢复（文件仍存在）；未通过复核
   *   的保持原状（仍是 ghost 或正常归档），不能因为请求过就一并抹掉；
   * - confirm → unarchiveSession 段与 delete() 的删除临界区经
   *   exclusive 互斥（见 exclusive）——官方写入串行只挡住其他归档集合
   *   写入者，挡不住不经过它的删除；
   */
  async function removeFromArchiveSet(ids: string[], confirm?: (sessionId: string) => Promise<boolean>): Promise<string[]> {
    const removedIds: string[] = [];
    for (const sessionId of new Set(ids)) {
      // confirm → 移除与 delete() 的删除临界区互斥（见 exclusive）。
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
   * （ghost，幂等删除）；unknown：宿主没给出该会话的 location（stat 返回
   * undefined/无 location），既不能确认存在也不能确认缺失。
   * unknown 与 absent 必须区分：删除语义里 absent 是幂等成功、unknown 是
   * "不能谎报成功也不能删错东西"的失败兜底。 */
  type FileStatus =
    | { state: 'located'; path: string; size: number; mtimeMs: number }
    | { state: 'absent' }
    | { state: 'unknown' };

  /**
   * 解析会话目录里的实际日志文件。stat 快照的 location 只指向当前格式版本
   * 的文件名（如 session.v2.jsonl.zstd），而历史上落盘的可能是旧代际名
   * （session.jsonl / session.v1.jsonl…等旧代际名）——stat 落空不等于会话不存在。官方布局是"一会话一
   * 目录"，目录路径不随代际变化，因此在快照给出的目录里扫描
   * session*.jsonl(.zstd) 取实际文件（多个代际并存时取最新 mtime）。
   * 扫描结果为空才认定文件不存在。
   *
   * 链接防护：目录/条目都先 lstat——目录是符号链接或非目录时直接返回 null
   * （不 readdir 目标目录、不跟随后代目录）；条目只接受真实文件（符号链接
   * 不算代际文件，避免后续删除穿透到链接目标）。
   */
  async function resolveGenerationFile(dir: string): Promise<string | null> {
    let dirInfo;
    try {
      dirInfo = await lstat(dir);
    } catch {
      return null; // 目录不存在：无任何代际文件
    }
    if (!dirInfo.isDirectory()) return null; // 符号链接/非目录：不跟随后代目录
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
        const info = await lstat(candidate);
        if (!info.isFile()) continue; // 链接/子目录不是代际文件
        if (latest === null || info.mtimeMs > latest.mtimeMs) latest = { path: candidate, mtimeMs: info.mtimeMs };
      } catch {} // 竞态消失的条目跳过
    }
    return latest?.path ?? null;
  }

  async function fileInfo(header: SessionHeader, signal?: AbortSignal): Promise<FileStatus> {
    // 宿主公开契约：stat(id) 返回的快照携带标准 `location`（0.2.2 起），
    // 这就是该会话当前代际落盘文件的权威路径；stat 返回 undefined 即会话不存在。
    let locationPath: string | undefined;
    try {
      const snapshot = await persistence.stat(header.id, { signal });
      locationPath = snapshot?.location?.path;
    } catch {
      // stat 抛错（后端异常/契约漂移）——既不能确认存在也不能确认缺失，
      // 必须按 unknown 处理。返回 absent 会让 delete() 把它记成
      // "幂等删除成功"（0.3.9 谎报成功的同源变体）；unknown 对应删除路径
      // 的 unlocatable 拒绝。
      return { state: 'unknown' };
    }
    if (typeof locationPath !== 'string' || locationPath.length === 0) {
      return { state: 'unknown' };
    }

    // 快照给的是当前代际名；旧代际落盘的可能是历史文件名（session.jsonl /
    // session.v1.jsonl…）。官方布局是"一会话一目录"，目录路径不随代际变化，
    // 因此在快照目录里扫描 session*.jsonl(.zstd) 取实际文件（多个代际并存时
    // 取最新 mtime）；扫描结果为空才认定文件不存在。
    const candidatePaths: string[] = [locationPath];
    const generation = await resolveGenerationFile(dirname(locationPath));
    if (generation !== null) candidatePaths.unshift(generation);
    for (const candidate of candidatePaths) {
      try {
        const info = await stat(candidate);
        return { state: 'located', path: candidate, size: info.size, mtimeMs: info.mtimeMs };
      } catch {} // ENOENT 或竞态：试下一个候选
    }
    return { state: 'absent' };
  }

  /** 删除后的立即复验：确认文件没有被宿主 materialize 的 mkdir -p 或
   * 写入方整体重建。返回 true 表示文件仍在(重现)。只有 ENOENT 视为已消失;
   * EACCES 等 stat 错误按「仍在」处理,让上层走二次删除并以真实错误上报,
   * 不谎报 deleted。不等待任何墙钟窗口——删除是否安全由删除前的显式状态
   * 判定（宿主内存中即 busy）承担,不靠 timing（RULE-049）。 */
  async function filePresent(path: string): Promise<boolean> {
    try {
      await statFile(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      return true;
    }
  }

  /**
   * 批量读标题（官方 sessionQuery 服务存在时）。
   *
   * 成本边界：官方实现对 **cold 会话** 是逐条整读日志折 title
   * （`readColdSessionLog`），并非 O(1) 索引读——归档越多越贵。因此调用方
   * 只在 projection 缓存与 mtime 缓存都未命中时才用它；返回 null 表示整单
   * 回退直读，Map 缺席的 id 表示该行 rejected（调用方对该行回退直读）。
   * 标题语义与直读一致（latest-wins fold，缺标题为 null）。
   *
   * live-preferred 的说明：归档会话已从会话列表移除、无法继续对话，不会
   * 再写持久化文件，内存与文件中的标题必然收敛；展示用标题取 fresher
   * 的一方无害（体积/mtime 等安全关键字段仍以文件为准）。
   */
  async function readTitlesBulk(ids: readonly SessionId[], signal?: AbortSignal): Promise<Map<string, string | null> | null> {
    if (sessionQueryTitles === undefined) return null;
    // 桥的契约只承诺「一组观测结果」，逐项形状仍按官方语义在这里防御性读取
    // （整单抛错 → null 全量回退；单行 rejected/异形 → 该行缺席 Map → 逐行回退）。
    let results: readonly unknown[];
    try {
      results = await sessionQueryTitles(ids, signal);
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

  /** 标题 mtime 缓存命中：文件未变即复用上次折叠结果（null 是有效标题态）。 */
  function titleFromMtimeCache(sessionId: SessionId, mtimeMs: number): string | null | undefined {
    const cached = titleCache.get(sessionId);
    return cached !== undefined && cached.mtimeMs === mtimeMs ? cached.title : undefined;
  }

  /** 记一条标题 mtime 缓存（FIFO 上限：已删除会话的条目不再被命中更新）。 */
  function rememberTitle(sessionId: SessionId, mtimeMs: number, title: string | null): void {
    if (titleCache.size >= TITLE_CACHE_LIMIT) {
      const oldest = titleCache.keys().next().value;
      if (oldest !== undefined) titleCache.delete(oldest);
    }
    titleCache.set(sessionId, { mtimeMs, title });
  }

  /**
   * 从 stat 快照定位会话文件（列表行的快路径）。
   *
   * `persistence.stat()` 返回的 `location.path` 就是该会话当前代际的权威
   * 落盘文件（后端已完成代际解析与首行校验），因此列表行直接 stat 它即可；
   * 不再逐行重跑 `persistence.stat()`（每行 O(项目目录数) 的全目录扫描）+
   * 代际目录 readdir。stat 失败（快照后迁移/删除的竞态）才退回 `fileInfo`
   * 的完整定位与 unknown/absent 语义。
   */
  async function locateSnapshotFile(snapshot: SessionPersistenceSnapshot, signal?: AbortSignal): Promise<FileStatus> {
    const locationPath = snapshot.location?.path;
    if (typeof locationPath === 'string' && locationPath.length > 0) {
      try {
        const info = await stat(locationPath);
        return { state: 'located', path: locationPath, size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        // 竞态：快照之后文件被迁走/删除 → 走完整定位（旧代际扫描 + unknown 兜底）。
      }
    }
    return fileInfo(snapshot.header, signal);
  }

  /**
   * 归档会话的展示行（面板 list 的数据面）。
   *
   * 性能契约（大量归档时必须成立）：
   * 1. 标题先读官方持久化 projection 缓存 `cachedSnapshot()`（零 I/O、同步），
   *    命中即不再碰日志。列表慢路径是 `sessionQuery.readTitleSnapshots()`——
   *    它对 cold 会话逐条整读日志，归档越多越慢，因此只作缓存未命中回退。
   * 2. 未命中 projection 缓存时再看本插件 mtime 缓存（同文件不重复折叠），
   *    仍未命中才走官方批量/逐条直读，并把成功结果写回 mtime 缓存。
   * 3. 行元数据（size/updatedAt）复用 stat 快照的 location 单次 stat，
   *    不再逐行重跑 persistence.stat + 代际目录扫描。
   */
  async function archivedRows(archived: readonly string[], signal?: AbortSignal): Promise<ArchiveListRow[]> {
    if (archived.length === 0) return [];
    const snapshots = await snapshotsByIds(archived, signal);
    interface RowSeed {
      sessionId: SessionId;
      snapshot: SessionPersistenceSnapshot;
      file: FileStatus;
      title: string | null | undefined;
    }
    const entries: Array<{ sessionId: SessionId; snapshot: SessionPersistenceSnapshot }> = [];
    for (const id of archived) {
      const snapshot = snapshots.get(id);
      if (snapshot === undefined) continue; // 幽灵 id：会话文件已不存在
      entries.push({ sessionId: id as SessionId, snapshot });
    }
    const seeds = await limitedConcurrency<RowSeed>(
      cfg.titleReadConcurrency,
      entries.map(({ sessionId, snapshot }) => async () => {
        const file = await locateSnapshotFile(snapshot, signal);
        const cached = readCachedTitle?.(snapshot.header);
        if (cached !== undefined) return { sessionId, snapshot, file, title: cached };
        const located = file.state === 'located' ? file : null;
        if (located !== null) {
          const byMtime = titleFromMtimeCache(sessionId, located.mtimeMs);
          if (byMtime !== undefined) return { sessionId, snapshot, file, title: byMtime };
        }
        return { sessionId, snapshot, file, title: undefined };
      }),
      signal,
    );
    // 只有真的未解析的 id 才走官方批量标题（cache 未命中才可能很贵）。
    const unresolved = seeds.filter((seed) => seed.title === undefined).map((seed) => seed.sessionId);
    const bulk = unresolved.length > 0 ? await readTitlesBulk(unresolved, signal) : null;
    return limitedConcurrency(
      cfg.titleReadConcurrency,
      seeds.map((seed) => async (): Promise<ArchiveListRow> => {
        const { sessionId, snapshot, file } = seed;
        const located = file.state === 'located' ? file : null;
        let title = seed.title;
        if (title === undefined) {
          if (bulk !== null && bulk.has(sessionId)) {
            title = bulk.get(sessionId) ?? null;
            if (located !== null) rememberTitle(sessionId, located.mtimeMs, title);
          } else {
            // 缓存与索引都没有：逐条直读折叠（失败回退 null，面板显示目录名）。
            let readFailed = false;
            try {
              title = await readTitle(persistence, sessionId, signal);
            } catch {
              readFailed = true;
              title = null;
            }
            // 读取失败不写缓存：一次瞬时 I/O 失败不应被固化成长期「无标题」。
            if (!readFailed && located !== null) rememberTitle(sessionId, located.mtimeMs, title);
          }
        }
        return {
          sessionId,
          title,
          cwd: snapshot.header.cwd ?? null,
          createdAt: snapshot.header.createdAt,
          updatedAt: located !== null ? located.mtimeMs : snapshot.header.createdAt,
          size: located !== null ? located.size : 0,
          live: isLive(sessionId),
        };
      }),
      signal,
    );
  }
  return {
    ctx,
    cfg,
    persistence,
    archivedSet,
    isLive,
    snapshotsByIds,
    exclusive,
    removeFromArchiveSet,
    resolveGenerationFile,
    fileInfo,
    filePresent,
    readTitlesBulk,
    archivedRows,
  }
}

/** 上下文对象：见 createHostContext（含五个方法需要的全部助手与共享状态）。 */
export type HostContext = ReturnType<typeof createHostContext>
