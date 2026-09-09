import type { Context as CordisContext } from "@deepseek-ai/cordis";

/**
 * 插件触达的 DSH service 面。按 dsh 0.1.3+ 持久化契约声明（0.1.2 的
 * `readFrom`/`locate` 已从抽象契约移除），但对仍在的旧方法一律以可选
 * 成员表达——host 逻辑运行时探测两种形状，兼容两条宿主线。
 */
declare module "@deepseek-ai/cordis" {
  interface Context extends CordisContext {
    workspaceRegistry: {
      [key: string]: any;
      [key: symbol]: any;
      /** 0.1.2 为属性数组，0.1.3 起为 getter（同样返回数组）；类型层取并集。 */
      archivedSessionIds: string[] | (() => string[]);
      enqueueOperation(operation: () => void | Promise<void>): Promise<void>;
      requireState(): { archivedSessionIds: string[]; [key: string]: any };
      setState(next: Record<string, any>): Promise<void> | void;
    };
    sessionPersistence: {
      [key: string]: any;
      [key: symbol]: any;
      /**
       * dsh 0.1.3+：`SessionPersistenceSnapshot[]`（`{ header, revision,
       * sizeBytes?, eventCount? }`）。0.1.2 及更早返回 `SessionHeader[]`。
       * host 逻辑经 headerOf() 归一，不依赖具体形状。
       */
      list(): Promise<Array<{ header?: { id: string; [key: string]: any }; id?: string; [key: string]: any }>>;
      /** 0.1.3+ 读事件流的契约路径：read 句柄。 */
      open(
        id: string,
        access: "read" | "write",
        options?: { signal?: AbortSignal },
      ): Promise<{
        readonly header: { id: string; cwd?: string; createdAt?: number; parentSession?: string; agentPreset?: string; [key: string]: any };
        read(offset?: number): Promise<{ events: Array<any>; [key: string]: any }>;
        close(): Promise<void>;
      }>;
      /** 0.1.3+：单会话观察（存在性/体积），不存在返回 undefined。 */
      stat?(id: string): Promise<{ header: { id: string; [key: string]: any }; [key: string]: any } | undefined>;
      /** 仅 0.1.2 及更早：按头定位物理路径。 */
      locate?(meta: { id: string; cwd?: string; [key: string]: any }): { kind: string; path: string; [key: string]: any } | undefined;
      /** 仅 0.1.2 及更早：读完整事件流。 */
      readFrom?(id: string, offset: number): Promise<{ meta: Record<string, any>; events: Array<any> }>;
    };
    sessions: {
      [key: string]: any;
      [key: symbol]: any;
      get(id: string): any;
    };
  }
}
