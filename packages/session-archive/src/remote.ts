/**
 * remote.ts — 归档管理插件的远程服务（侧边栏归档面板通过 ctx.remote.sessionArchive 调用）。
 *
 * 远程服务面用官方标准装饰器声明：TypertRemoteService 的子类 + 具体方法上的
 * @Remote。@Remote 标记走 typert-protocol 的私有 descriptor，必须在**具体业务
 * 方法**上（不要包一层转发），并且 service key 是构造里的字符串字面量——
 * typert 生成器（@deepseek-ai/dsh-typert-generator）静态分析这三点，产出
 * ./typert（Host 工件）与 ./remote（Client 调用面）。本文件不再手写这些工件。
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
 * host 层把 signal 透传给 persistence.open/read/stat 与标题索引，并在
 * 批量循环/分块读取处 cooperative 检查。
 *
 * 能力方法（RULE-032）：@Remote 方法体负责入口业务编排——入参断言、
 * 归档成员资格闸门、逐项结果归类与 remoteAccess 过滤；持久化/文件系统原语
 * 仍由 host 模块（index.ts 传入的 archiveHost）提供。不再只是单行转发。
 *
 * @module @chaoset/session-archive/remote
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remote-access';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { assertSessionId, assertSessionIdArray } from './session-id.js';
import type { ArchiveHost } from './archive-host.js';
import type {
  ArchiveCountResult,
  ArchiveDeleteResult,
  ArchiveDetailResult,
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
 * @param config - { host: archiveHost }。
 */
export class SessionArchiveGateway extends TypertRemoteService {
  /** remoteAccess 是 list/count 逐项过滤与 resources 判定的必挂宿主服务：
   * 作为服务级依赖声明（不写进插件入口的 inject——插件入口只声明
   * workspaceRegistry/sessionPersistence/sessions，Gateway fiber 自己等它）。 */
  static inject = ['remoteAccess'];

  private host: ArchiveHost;

  constructor(ctx: Context, config: { host: ArchiveHost }) {
    super(ctx, 'sessionArchive');
    this.host = config.host;
  }

  /** 列出全部归档会话（文件已删的幽灵归档记录不显示）。
   * 无具体会话参数，入口按 global 判定；返回前逐行过滤，非 owner 只看到
   * 自己的会话（官方 session/list 同款）。 */
  @Remote('list')
  async list(signal: AbortSignal): Promise<ArchiveListResult> {
    signal.throwIfAborted();
    const result = await this.host.list(signal);
    return {
      items: result.items.filter((item) =>
        this.ctx.remoteAccess.allows({ kind: 'session', id: item.sessionId as SessionId })),
    };
  }

  /** 归档会话计数（侧边栏徽标的关闭态轮询只调这里）。
   * 无具体会话参数，入口按 global 判定；计数用逐项过滤后的数量。 */
  @Remote('count')
  async count(signal: AbortSignal): Promise<ArchiveCountResult> {
    signal.throwIfAborted();
    const ids = await this.host.existingIds(signal);
    return {
      count: ids.filter((sessionId) =>
        this.ctx.remoteAccess.allows({ kind: 'session', id: sessionId as SessionId })).length,
    };
  }

  /**
   * 读取一个归档会话的只读详情（标题 + 文本消息）。
   * @param sessionId - 归档会话 id；非归档会话拒绝读取。
   */
  @Remote('detail')
  async detail(sessionId: string, signal: AbortSignal): Promise<ArchiveDetailResult> {
    // 方法层断言与 host 层共享同一实现（session-id.ts）：单测直调方法不经
    // 生成 codec，多层防御保持一致。
    assertSessionId(sessionId);
    signal.throwIfAborted();
    // 归档成员资格是 detail 的业务前置（不是可转发的细节）：非归档会话
    // 拒绝读取，走官方 RemoteError（稳定 code + types.ts 声明的 details）。
    // host 侧保留同一检查作纵深防御（直调 host 的测试/内部路径也受控）。
    if (!this.host.archivedSet().has(sessionId)) {
      throw new RemoteError('session-archive/not-archived', 'session not archived: ' + sessionId, { sessionId });
    }
    return this.host.detail(sessionId, signal);
  }

  /**
   * 批量彻底删除归档会话。
   * @param sessionIds - 归档会话 id 列表；非归档成员拒绝、活跃生成流拒绝。
   */
  @Remote({ name: 'delete', resources: { session: sessionIdsAsResources } })
  async delete(sessionIds: readonly string[], signal: AbortSignal): Promise<ArchiveDeleteResult> {
    signal.throwIfAborted();
    const unique = [...new Set(assertSessionIdArray(sessionIds))];
    // 入口业务闸门：只有归档成员进入 host 的删除流程；非成员在这里逐项
    // 归类为 not-archived（与 host 同一词表），不进入删除循环、不谎报成功。
    const archived = this.host.archivedSet();
    const members = unique.filter((sessionId) => archived.has(sessionId));
    const foreign = unique
      .filter((sessionId) => !archived.has(sessionId))
      .map((sessionId) => ({ sessionId, reason: 'not-archived' }));
    const result = await this.host.deleteArchived(members, signal);
    return { ...result, failed: [...foreign, ...result.failed] };
  }

  /**
   * 批量恢复归档会话（仅从归档集合移除，会话数据不动）。
   * @param sessionIds - 归档会话 id 列表。
   */
  @Remote({ name: 'unarchive', resources: { session: sessionIdsAsResources } })
  async unarchive(sessionIds: readonly string[], signal: AbortSignal): Promise<ArchiveUnarchiveResult> {
    signal.throwIfAborted();
    const unique = [...new Set(assertSessionIdArray(sessionIds))];
    // 与 delete 对称的入口闸门：非归档成员直接归入 not-archived，不进入
    // host 的 confirm → unarchiveSession 临界区（避免无谓的持久化读）。
    const archived = this.host.archivedSet();
    const members = unique.filter((sessionId) => archived.has(sessionId));
    const foreign = unique
      .filter((sessionId) => !archived.has(sessionId))
      .map((sessionId) => ({ sessionId, reason: 'not-archived' }));
    const result = await this.host.unarchive(members, signal);
    return { ...result, failed: [...foreign, ...result.failed] };
  }
}
