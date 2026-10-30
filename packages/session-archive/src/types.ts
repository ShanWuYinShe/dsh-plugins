/**
 * types.ts — Remote 服务面（归档面板 list/count/detail/delete/unarchive）的边界类型。
 *
 * 这些类型是 Host 与 Client 的公共 wire 契约：typert 生成器从 Host 方法签名
 * 生成 ./remote 调用面时，按包内公共非根子路径（package.json 的 "./types"）
 * 引用它们，因此必须保持 JSON 可序列化、只在此处定义一份。JSDoc 会被生成器
 * 收进工件（线上描述/JSON Schema），改类型时一并维护注释。
 *
 * @module @chaoset/session-archive/types
 */

/** 归档会话计数（侧边栏徽标轮询的轻端点结果）。 */
export interface ArchiveCountResult {
  /** 存在性过滤后的真实归档会话数（文件已删的幽灵归档记录不计）。 */
  readonly count: number;
}

/** 归档会话列表行。 */
export interface ArchiveListRow {
  /** 会话 id。 */
  readonly sessionId: string;
  /** 最近标题；无标题时为 null（面板显示目录名）。 */
  readonly title: string | null;
  /** 会话创建时的工作目录；旧日志可能缺失。 */
  readonly cwd: string | null;
  /** 会话创建时间（Unix epoch 毫秒）。 */
  readonly createdAt: number;
  /** 持久化文件最后修改时间（Unix epoch 毫秒）。 */
  readonly updatedAt: number;
  /** 持久化文件字节数。 */
  readonly size: number;
  /** 会话当前是否在内存中存在且未归档。 */
  readonly live: boolean;
}

/** list() 的返回：全部归档会话（存在性过滤后）。 */
export interface ArchiveListResult {
  /** 归档会话行。 */
  readonly items: readonly ArchiveListRow[];
}

/** 归档会话详情里回显的会话头（只含展示需要的字段）。 */
export interface ArchiveDetailHeader {
  /** 会话创建时的工作目录；旧日志可能缺失。 */
  readonly cwd: string | null;
  /** 会话创建时间（Unix epoch 毫秒）。 */
  readonly createdAt: number;
  /** 直接创建者的会话 id（子会话才有）。 */
  readonly parentSession: string | null;
  /** 创建该会话的 agent preset 名（按会话组合部署时才有）。 */
  readonly agentPreset: string | null;
}

/** 归档会话详情里的一条消息预览。 */
export interface ArchiveDetailMessage {
  /** 消息角色。 */
  readonly role: 'user' | 'assistant';
  /** 提取出的纯文本（超长已截断）。 */
  readonly text: string;
  /** 事件时间（Unix epoch 毫秒）。 */
  readonly time: number;
}

/** detail() 的返回：一个归档会话的只读详情。 */
export interface ArchiveDetailResult {
  /** 会话 id。 */
  readonly sessionId: string;
  /** 会话头。 */
  readonly header: ArchiveDetailHeader;
  /** 最近标题；无标题时为 null。 */
  readonly title: string | null;
  /** 返回的消息条数（受配置上限约束）。 */
  readonly messageCount: number;
  /** 全部非空文本消息条数（含被截断未返回的部分）。 */
  readonly totalMessageCount: number;
  /** 是否因上限截断。 */
  readonly truncated: boolean;
  /** 消息预览（按日志顺序）。 */
  readonly messages: readonly ArchiveDetailMessage[];
  /** 会话当前是否在内存中存在且未归档。 */
  readonly live: boolean;
}

/** 批量操作中单个会话的失败原因。 */
export interface ArchiveFailure {
  /** 会话 id。 */
  readonly sessionId: string;
  /** 失败原因（not-archived / unenumerable / unlocatable / busy / reappeared / not-restorable 或底层错误消息）。 */
  readonly reason: string;
}

/** deleteArchived() 的返回。 */
export interface ArchiveDeleteResult {
  /** 已彻底删除的会话 id。 */
  readonly deleted: readonly string[];
  /** 失败的会话及原因。 */
  readonly failed: readonly ArchiveFailure[];
  /** 从归档集合移除的条数（删除恒为 0：保留 ghost id 防内存会话重现侧边栏）。 */
  readonly removedFromArchive: number;
  /** 文件已删但内存会话仍在的 id——原生「已归档」页需宿主重启才消失。 */
  readonly needsRestart: readonly string[];
}

/** unarchive() 的返回。 */
export interface ArchiveUnarchiveResult {
  /** 已恢复（移出归档集合）的会话 id。 */
  readonly restored: readonly string[];
  /** 失败的会话及原因。 */
  readonly failed: readonly ArchiveFailure[];
  /** 实际移出归档集合的条数。 */
  readonly removedFromArchive: number;
}

/**
 * 本插件的 Remote 业务失败码（typert-protocol 的 RemoteErrorDetailsMap 合并
 * 扩展，官方 dsh-session 的 "session/not-found" 同款做法）：Host 在失败点抛
 * RemoteError，Client 按 code 判别（不要用 instanceof）。
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** detail 的目标会话不在归档集合：非归档成员拒绝读取（防止读到任意未归档会话）。 */
    'session-archive/not-archived': {
      /** 被拒绝读取的会话 id。 */
      readonly sessionId: string;
    };
  }
}
