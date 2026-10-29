/**
 * remote.ts — 归档管理插件的远程服务（侧边栏归档面板通过 ctx.remote.sessionArchive 调用）。
 *
 * 远程服务面用官方标准装饰器声明：TypertRemoteService 的子类 + 具体方法上的
 * @Remote。@Remote 标记走 typert-protocol 的私有 descriptor，必须在**具体业务
 * 方法**上（不要包一层转发），并且 service key 是构造里的字符串字面量——
 * typert 生成器（@deepseek-ai/dsh-typert-generator）静态分析这三点，产出
 * ./typert（Host 工件）与 ./remote（Client 调用面）。本文件不再手写这些工件。
 *
 * 所有逻辑委托给 host 模块（index.ts 传入的 archiveHost）。
 *
 * @module @chaoset/session-archive/remote
 */

import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { assertSessionId, assertSessionIdArray } from './session-id.js';
import type { createArchiveHost } from './archive-host.js';
import type {
  ArchiveCountResult,
  ArchiveDeleteResult,
  ArchiveDetailResult,
  ArchiveListResult,
  ArchiveUnarchiveResult,
} from './types.js';

/** 委托目标：index.ts 用 createArchiveHost(ctx, cfg) 构造的 host 组合。 */
export type ArchiveHost = ReturnType<typeof createArchiveHost>;

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
  private host: ArchiveHost;

  constructor(ctx: Context, config: { host: ArchiveHost }) {
    super(ctx, 'sessionArchive');
    this.host = config.host;
  }

  /** 列出全部归档会话（文件已删的幽灵归档记录不显示）。 */
  @Remote('list')
  list(): Promise<ArchiveListResult> {
    return this.host.list();
  }

  /** 归档会话计数（侧边栏徽标的关闭态轮询只调这里）。 */
  @Remote('count')
  count(): Promise<ArchiveCountResult> {
    return this.host.count();
  }

  /**
   * 读取一个归档会话的只读详情（标题 + 文本消息）。
   * @param sessionId - 归档会话 id；非归档会话拒绝读取。
   */
  @Remote('detail')
  detail(sessionId: string): Promise<ArchiveDetailResult> {
    // 方法层断言与 host 层共享同一实现（session-id.ts）：单测直调方法不经
    // 生成 codec，多层防御保持一致。
    assertSessionId(sessionId);
    return this.host.detail(sessionId);
  }

  /**
   * 批量彻底删除归档会话。
   * @param sessionIds - 归档会话 id 列表；非归档成员拒绝、活跃生成流拒绝。
   */
  @Remote('delete')
  delete(sessionIds: readonly string[]): Promise<ArchiveDeleteResult> {
    return this.host.deleteArchived(assertSessionIdArray(sessionIds));
  }

  /**
   * 批量恢复归档会话（仅从归档集合移除，会话数据不动）。
   * @param sessionIds - 归档会话 id 列表。
   */
  @Remote('unarchive')
  unarchive(sessionIds: readonly string[]): Promise<ArchiveUnarchiveResult> {
    return this.host.unarchive(assertSessionIdArray(sessionIds));
  }
}
