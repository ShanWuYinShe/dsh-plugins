/**
 * remote.ts — 归档管理插件的远程服务（侧边栏归档面板通过 ctx.remote.sessionArchive 调用）
 *
 * 加载器与标记机制（typert-protocol 惰性加载、markRemoteMethod、
 * runPendingMarks）在 ./typert-loader.js：那个文件与 sandbox-extra-roots 的同名
 * 文件**逐字相同**，由根 test/bundle.test.ts 的一致性锁保证（改一侧必须改
 * 另一侧）。本文件只保留本包特有的网关。
 *
 * 模块加载失败由 index.ts 的动态 import 捕获——核心 host 逻辑照常注册，
 * 仅侧边栏面板的远程读写不可用。
 */

import type { Context } from "@deepseek-ai/cordis";
import { assertSessionId, assertSessionIdArray } from "./session-id.js";
import { TypertRemoteService, markRemoteMethod, runPendingMarks } from "./typert-loader.js";

/**
 * 归档管理远程服务：list 列出归档会话；count 归档计数（徽标轮询轻端点）；
 * detail 读取会话内容；
 * delete 批量删除归档会话（文件删除，归档集合保留 ghost id 防止内存会话
 * 重现侧边栏；返回附带 needsRestart——文件已删但内存会话仍在的 id，原生
 * "设置 → 已归档会话"页在宿主重启前仍会显示它们）；unarchive 批量恢复归档
 * （仅限仍存在文件的会话）。
 * 所有逻辑委托给 host 模块（lib/index.ts 传入的 archiveHost）。
 * @param ctx - 插件上下文。
 * @param config - { host: archiveHost, serviceKey: 远程服务名 }。
 */
export class SessionArchiveGateway extends TypertRemoteService {
  private host: any;
  constructor(ctx: Context, config: { host: any; serviceKey: string }) {
    super(ctx, config.serviceKey);
    runPendingMarks(this);
    this.host = config.host;
  }
  list() {
    return this.host.list();
  }
  count() {
    return this.host.count();
  }
  detail(sessionId: string) {
    // 与 codec 层（typert.host.ts）共享同一断言实现（session-id.ts）：
    // 单测直调方法不经 codec，历史上两处手抄曾漂移（方法层漏了非空与上限）。
    assertSessionId(sessionId);
    return this.host.detail(sessionId);
  }
  delete(sessionIds: string[]) {
    return this.host.deleteArchived(assertSessionIdArray(sessionIds));
  }
  unarchive(sessionIds: string[]) {
    return this.host.unarchive(assertSessionIdArray(sessionIds));
  }
}
markRemoteMethod(SessionArchiveGateway.prototype, "list");
markRemoteMethod(SessionArchiveGateway.prototype, "count");
markRemoteMethod(SessionArchiveGateway.prototype, "detail");
markRemoteMethod(SessionArchiveGateway.prototype, "delete");
markRemoteMethod(SessionArchiveGateway.prototype, "unarchive");
// 模块加载时立即执行标记（Object.create 模拟实例；构造函数里的 runPendingMarks 幂等保留无害）。
runPendingMarks(Object.create(SessionArchiveGateway.prototype));
