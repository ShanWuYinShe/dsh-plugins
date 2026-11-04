/**
 * remote.ts — 归档管理插件的远程服务（侧边栏归档面板通过 ctx.remote.sessionArchive 调用）。
 *
 * 远程服务面用官方标准装饰器声明：TypertRemoteService 的子类 + 具体方法上的
 * @Remote。@Remote 标记走 typert-protocol 的私有 descriptor，必须在**具体业务
 * 方法**上（不要包一层转发），并且 service key 是构造里的字符串字面量——
 * typert 生成器（@deepseek-ai/dsh-typert-generator）静态分析这三点，产出
 * ./typert（Host 工件）与 ./remote（Client 调用面）。
 *
 * 能力方法（RULE-032）：五个 @Remote 方法体就是能力实现本身——入参校验、
 * 归档成员闸门、持久化/文件系统编排、逐项结果归类与 remoteAccess 过滤都在
 * 方法体内；只把可复用的文件/事件原语留在 archive-host-context.ts（内部
 * deps，不对外）。不再有 archiveHost 转发对象。
 *
 * 访问控制：每个方法必须通过 `resources` reader 或默认 resolver 声明它访问的
 * 资源（dsh-api-remote-access 不检查未声明的资源，缺省即按 global 判定）。
 * - detail(sessionId)：参数名命中 session 的默认 resolver（resolveSessionResource），
 *   不加 reader；
 * - delete/unarchive(sessionIds[])：默认 resolver 只认命名参数/对象字段的
 *   sessionId，**不解析数组参数**，必须显式声明数组 reader（见下方
 *   sessionIdsAsResources）——否则非 owner 批量调用按 global 判定，绕过会话级
 *   授权；
 * - list/count：方法没有具体会话参数（Gateway 在 lookup 解析前读不到资源），
 *   因此按 global 判定入口调用；**返回的每一行逐项**经
 *   `this.ctx.remoteAccess.allows({ kind: 'session', id })` 过滤（count 用过滤后
 *   的数量）——官方 session/list 的同款模型（api-session-controller 的 list
 *   先取全量再逐行 filter），非 owner 只能看到自己的归档元数据。
 *
 * 取消（RULE-037）：5 个方法末尾都声明 `signal: AbortSignal`——typert
 * 生成器把它识别为 Gateway 注入项（不是 JSON wire 参数），调用侧不传；
 * 持久化读写把 signal 透传给 persistence.open/read/stat 与标题索引，并在
 * 批量循环/分块读取处 cooperative 检查。
 *
 * @module @chaoset/session-archive/remote
 */

import { stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remote-access';
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createHostContext } from './archive-host-context.js';
import type { HostContext, StatFile } from './archive-host-context.js';
import { assertSessionId, assertSessionIdArray } from './session-id.js';
import type { SessionArchiveConfig } from './plugin-config.js';
import { limitedConcurrency, messageText, removeSessionDirIfOwned, scanSession } from './session-scan.js';
import type {
  ArchiveCountResult,
  ArchiveDeleteResult,
  ArchiveDetailMessage,
  ArchiveDetailResult,
  ArchiveFailure,
  ArchiveListResult,
  ArchiveUnarchiveResult,
} from './types.js';

/**
 * 批量方法的 session 资源 reader：把数组参数逐项声明为 session 资源，
 * 由 Gateway 在非 owner 调用时逐个会话做授权判定。
 *
 * 返回 array（可为空）而非 undefined：空数组由 Gateway 判为 resource-invalid
 * 拒绝调用（fail-closed；owner 调用不经过资源解析，行为不变）。类型上是
 * readonly SessionId[]——wire 层是字符串数组，断言后交给协议的资源类型。
 *
 * 只读，不解析身份：Gateway 在 lookup 解析之前调用 reader，语义与官方默认
 * resolver 一致（读参数而非解析后的对象）。
 */
function sessionIdsAsResources(sessionIds: readonly string[]): readonly SessionId[] {
  return sessionIds as readonly SessionId[];
}

/**
 * 归档管理远程服务：list 列出归档会话；count 归档计数（徽标轮询轻端点）；
 * detail 读取会话内容；delete 批量彻底删除归档会话（文件删除，归档集合保留
 * ghost id 防止内存会话重现侧边栏；返回附带 needsRestart——文件已删但内存
 * 会话仍在的 id，原生「设置 → 已归档会话」页在宿主重启前仍会显示它们）；
 * unarchive 批量恢复归档（仅限仍存在文件的会话）。
 *
 * @param ctx - 插件上下文。
 * @param config - { cfg, statFile? }：生效配置与可选 stat 测试缝。
 */
export class SessionArchiveGateway extends TypertRemoteService {
  /** remoteAccess 是 list/count 逐项过滤与 resources 判定的必挂宿主服务：
   * 作为服务级依赖声明（不写进插件入口的 inject——插件入口只声明
   * workspaceRegistry/sessionPersistence/sessions，Gateway fiber 自己等它）。 */
  static inject = ['remoteAccess'];

  /** 内部依赖装配（deps 对象）：归档集合快照、持久化句柄、文件/事件原语。 */
  private readonly deps: HostContext;

  constructor(ctx: Context, config: { cfg: SessionArchiveConfig; statFile?: StatFile }) {
    super(ctx, 'sessionArchive');
    this.deps = createHostContext(ctx, config.cfg, config.statFile);
  }

  /** 插件日志通道（所有告警统一走宿主 logger）。 */
  private warn(message: string): void {
    this.deps.ctx.logger?.warn?.(message);
  }

  /** stat 一个路径：只有 ENOENT 视为"文件已消失"（null），其余错误上抛以真实原因计入 failed。 */
  private statOrNull(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    return stat(path).then(
      (info) => ({ size: info.size, mtimeMs: info.mtimeMs }),
      (error: NodeJS.ErrnoException) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      },
    );
  }

  /** 存在性过滤后的归档 id（幽灵记录不计；只逐 id stat，不读事件流/标题）。
   * count 与逐项 remoteAccess 过滤共用这一个轻量口径。 */
  private async existingIds(signal?: AbortSignal): Promise<string[]> {
    const archived = [...this.deps.archivedSet()];
    if (archived.length === 0) return [];
    const snapshots = await this.deps.snapshotsByIds(archived, signal);
    return archived.filter((sessionId) => snapshots.has(sessionId));
  }

  /** 删除前置的显式状态判定（RULE-049：正确性来自显式状态，不来自计时）。
   * 宿主 `sessions` 服务已 inject：会话仍在内存中即视为「可能活跃」，
   * 拒绝不可逆删除（README 的 busy 语义）。归档会话理论上不应再写盘，
   * 但宿主重启/客户端恢复 tab 都可能把归档会话重新挂进内存——此时删它
   * 存在「删掉活跃写入方正在 append 的日志」的风险，拒绝比启发式探测安全。
   * 返回 true（busy）时已记账。 */
  private busyIfLive(failed: ArchiveFailure[], sessionId: string): boolean {
    if (this.deps.ctx.sessions.get(sessionId as SessionId) === undefined) return false;
    failed.push({ sessionId, reason: 'busy' });
    return true;
  }

  /** 常规删除流（located 路径），必须在 exclusive 临界区内调用：
   * 显式状态复核 → TOCTOU 复核 → rm → 立即复验（重建则再删一次）。 */
  private async deleteLocatedFile(
    failed: ArchiveFailure[],
    deleted: string[],
    needsRestart: string[],
    sessionId: string,
    initialPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    let path = initialPath;
    try {
      // 锁内再次读宿主内存状态（循环外可能已被恢复/进入），保持显式判定。
      if (this.busyIfLive(failed, sessionId)) return;
      // TOCTOU 复核:fileInfo 的 stat 是快照,检查与 rm 之间文件可能
      // 恰好变化;rm 前重取一次。只有 ENOENT 才是「已消失」,其余错误
      // 上抛以真实原因计入 failed。
      let fresh = await this.statOrNull(path);
      if (fresh === null) {
        // stat 落空 ≠ 会话数据已删:jsonl 后端的格式迁移是"写临时文件 +
        // rename",若迁移恰好落在锁外定位与本次复核之间,旧代际路径已
        // 被 rename 走,而新代际文件仍在同一目录——直接记账会出现"已删
        // 却仍在列表"。复扫目录:扫到实际代际文件就以它为新删除目标;
        // 确实无任何代际文件才认定删除完成(顺带补上目录清理)。
        const migrated = await this.deps.resolveGenerationFile(dirname(path));
        if (migrated !== null) path = migrated;
        fresh = await this.statOrNull(path);
        if (fresh === null) {
          // 复扫后仍落空(无新代际,或迁移竞态二连/并发他删):按幂等
          // 删除处理,列表的存在性过滤自会隐藏幽灵 id。
          await removeSessionDirIfOwned(sessionId, path, (message) => this.warn(message));
          this.markDeleted(deleted, needsRestart, sessionId);
          return;
        }
      }
      await rm(path, { force: true });
      await removeSessionDirIfOwned(sessionId, path, (message) => this.warn(message));
      // 删除后的**立即**复验（无 sleep）：防宿主 materialize 的
      // mkdir -p / 写入方竞态把路径重建。重现则再删一次；仍压不掉计
      // failed('reappeared')。安全性已由删除前的显式状态判定承担，
      // 这里的复验只负责「不谎报已彻底删除」。
      if (await this.deps.filePresent(path)) {
        try {
          await rm(path, { force: true });
          await removeSessionDirIfOwned(sessionId, path, (message) => this.warn(message));
        } catch (error) {
          // 二次删除失败必须以真实原因上报:吞掉会让 EPERM/EBUSY 被
          // 误标为 reappeared,把排障方向带偏。
          this.warn(`session-archive: second delete failed for ${sessionId}: ${String(error)}`);
          failed.push({ sessionId, reason: (error as Error)?.message ?? 'delete-failed' });
          return;
        }
        if (await this.deps.filePresent(path)) {
          failed.push({ sessionId, reason: 'reappeared' });
          return;
        }
      }
      this.markDeleted(deleted, needsRestart, sessionId);
    } catch (error) {
      failed.push({ sessionId, reason: (error as Error)?.message ?? 'delete-failed' });
    }
    signal.throwIfAborted();
  }

  /** 删除成功记账：文件已删、但内存会话仍在的 id 需要宿主重启才能从原生
   * "设置 → 已归档会话"页消失，如实返回给调用方提示用户。 */
  private markDeleted(deleted: string[], needsRestart: string[], sessionId: string): void {
    deleted.push(sessionId);
    if (this.deps.ctx.sessions.get(sessionId as SessionId) !== undefined) needsRestart.push(sessionId);
  }

  private allows(sessionId: string): boolean {
    return this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId as SessionId });
  }

  /** 列出全部归档会话（文件已删的幽灵归档记录不显示）。
   * 无具体会话参数，入口按 global 判定；返回前逐行过滤，非 owner 只看到
   * 自己的会话（官方 session/list 同款）。 */
  @Remote('list')
  async list(signal: AbortSignal): Promise<ArchiveListResult> {
    signal.throwIfAborted();
    const { archivedSet, snapshotsByIds, readTitlesBulk, rowFor, cfg } = this.deps;
    const archived = [...archivedSet()];
    if (archived.length === 0) return { items: [] };
    const snapshots = await snapshotsByIds(archived, signal);
    const rows: Array<{ sessionId: string; header: SessionHeader }> = [];
    for (const sessionId of archived) {
      const snapshot = snapshots.get(sessionId);
      if (snapshot === undefined) continue; // 幽灵 id：会话文件已不存在
      rows.push({ sessionId, header: snapshot.header });
    }
    // 标题优先走官方索引批量读（无 sessionQuery/整单失败时 readTitlesBulk
    // 返回 null，逐行回退直读；单行 rejected 同理）。存在性过滤与体积/mtime
    // 仍以文件为准，不受索引影响。
    const bulk = await readTitlesBulk(rows.map(({ sessionId }) => sessionId as SessionId), signal);
    const items = await limitedConcurrency(
      cfg.titleReadConcurrency,
      rows.map(({ sessionId, header }) => () => rowFor(sessionId as SessionId, header, bulk, signal)),
      signal,
    );
    return { items: items.filter((item) => this.allows(item.sessionId)) };
  }

  /** 归档会话计数（侧边栏徽标的关闭态轮询只调这里）。
   * 无具体会话参数，入口按 global 判定；计数用逐项过滤后的数量。 */
  @Remote('count')
  async count(signal: AbortSignal): Promise<ArchiveCountResult> {
    signal.throwIfAborted();
    const ids = await this.existingIds(signal);
    return { count: ids.filter((sessionId) => this.allows(sessionId)).length };
  }

  /**
   * 读取一个归档会话的只读详情（标题 + 文本消息）。仅归档会话可读：
   * detail 是对外暴露的远程端点,不校验成员资格就能读到任意未归档会话。
   * 拒绝走官方 RemoteError：稳定 code + 类型化 details（types.ts 的
   * RemoteErrorDetailsMap 合并扩展），Client 按 code 判别而非 instanceof。
   */
  @Remote('detail')
  async detail(sessionId: string, signal: AbortSignal): Promise<ArchiveDetailResult> {
    // 方法层断言与 host 层共享同一实现（session-id.ts）：单测直调方法不经
    // 生成 codec，多层防御保持一致。
    assertSessionId(sessionId);
    signal.throwIfAborted();
    const { archivedSet, cfg, isLive, persistence } = this.deps;
    if (!archivedSet().has(sessionId)) {
      throw new RemoteError('session-archive/not-archived', 'session not archived: ' + sessionId, { sessionId });
    }
    const id = sessionId as SessionId;
    // 事件流分块消费（readSession 时代 read(0) 一次性物化全部事件）:
    // 头从句柄上取,消息逐块提取,达到上限后只计数不再拼接文本;
    // title 事件同趟收集(fold 只消费最后一个,全量物化没有必要)。
    const titleEvents: SessionEvent[] = [];
    // time 用官方 SessionEvent.time（Unix epoch 毫秒）：边界类型 ArchiveDetailMessage
    // 是 JSON 契约，不能用 unknown（生成器会拒绝非 JSON 类型）。
    const messages: ArchiveDetailMessage[] = [];
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
    }, signal);
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
  }

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
   * 失败语义（failed[].reason）：'not-archived' 非归档成员；'busy' 会话在
   * 宿主内存中（显式状态，见 busyIfLive）；'unenumerable' 文件存在但持久化
   * 枚举不到（首行损坏的孤儿），或无法确认文件已消失的 ghost id；
   * 'reappeared' 删除后被重建、二次删除仍压不掉；其余为底层删除错误消息。
   *
   * 目录/旧代际清理失败同样计入 failed：removeSessionDirIfOwned 在降级路径
   * （目录归属校验不通过、或目录里还有他者日志）会逐文件清理本会话的
   * session[.vN].jsonl[.zstd] 旧代际，清理后仍有残留（删除失败、被重建、
   * 或归属无法确认）时抛错——此处 catch 把真实原因记入 failed，绝不把
   * 「仍有本会话数据残留」的 id 记成 deleted。
   */
  @Remote({ name: 'delete', resources: { session: sessionIdsAsResources } })
  async delete(sessionIds: readonly string[], signal: AbortSignal): Promise<ArchiveDeleteResult> {
    signal.throwIfAborted();
    const { archivedSet, fileInfo, snapshotsByIds, exclusive } = this.deps;
    const unique = [...new Set(assertSessionIdArray(sessionIds))];
    const deleted: string[] = [];
    const failed: ArchiveFailure[] = [];
    const needsRestart: string[] = [];
    // 入口业务闸门：只有归档成员进入删除流程；非成员在这里逐项归类为
    // not-archived（与 host 同一词表），不进入删除循环、不谎报成功。
    const archived = archivedSet();
    const members = unique.filter((sessionId) => archived.has(sessionId));
    failed.push(...unique
      .filter((sessionId) => !archived.has(sessionId))
      .map((sessionId) => ({ sessionId, reason: 'not-archived' })));
    // 快照只 stat 归档成员:persistence 覆盖所有持久化会话而非仅归档会话,
    // 不校验的话任何"未归档、不在内存"的会话 id 都会绕过 busy 保护被不可逆
    // 物理删除。
    const snapshots = await snapshotsByIds(members, signal);

    for (const sessionId of members) {
      signal?.throwIfAborted();
      const snapshot = snapshots.get(sessionId);
      if (snapshot === undefined) {
        // ghost id(枚举不到)。"枚举不到 ≠ 文件不存在":首行损坏的日志会被
        // persistence 静默跳过;而 jsonl 后端按 cwd 分目录,ghost 探测没有
        // header、拿不到 cwd,stat 无法反推目录——既探不到真实文件,也确认不了缺失。因此 ghost 一律不能当"已删"报成功
        // (0.3.9 谎报成功的同源变体),计入 failed;ghost id 留在归档集合,
        // 由 list() 的存在性过滤隐藏,面板与侧边栏均不可见。
        failed.push({ sessionId, reason: 'unenumerable' });
        continue;
      }
      const header = snapshot.header;
      const file = await fileInfo(header, signal);
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
          // 文件不存在也要先判显式状态：内存中的会话可能马上要重建日志，
          // 此时报「幂等删除成功」会让 later 写入把会话复活成幽灵数据。
          if (this.busyIfLive(failed, sessionId)) return;
          const fresh = await fileInfo(header, signal);
          if (fresh.state === 'unknown') {
            failed.push({ sessionId, reason: 'unlocatable' });
            return;
          }
          if (fresh.state === 'absent') {
            this.markDeleted(deleted, needsRestart, sessionId);
            return;
          }
          await this.deleteLocatedFile(failed, deleted, needsRestart, sessionId, fresh.path, signal);
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
        await this.deleteLocatedFile(failed, deleted, needsRestart, sessionId, file.path, signal);
      });
    }
    return { deleted, failed, removedFromArchive: 0, needsRestart };
  }

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
  @Remote({ name: 'unarchive', resources: { session: sessionIdsAsResources } })
  async unarchive(sessionIds: readonly string[], signal: AbortSignal): Promise<ArchiveUnarchiveResult> {
    signal.throwIfAborted();
    const { archivedSet, fileInfo, removeFromArchiveSet, snapshotsByIds } = this.deps;
    const unique = [...new Set(assertSessionIdArray(sessionIds))];
    const archived = archivedSet();
    const members = unique.filter((sessionId) => archived.has(sessionId));
    const failed: ArchiveFailure[] = unique
      .filter((sessionId) => !archived.has(sessionId))
      .map((sessionId) => ({ sessionId, reason: 'not-archived' }));
    const snapshots = await snapshotsByIds(members, signal);
    // 锁外先做一遍廉价过滤(明显不可恢复的直接淘汰),锁内由 confirm 复核,
    // 消除与并发 delete 的检查-移除窗口。
    const candidates: string[] = [];
    for (const sessionId of members) {
      signal?.throwIfAborted();
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
        const file = await fileInfo(snapshot.header, signal);
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
  }
}
