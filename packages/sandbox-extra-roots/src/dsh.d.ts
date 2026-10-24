import type { Context as CordisContext } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context extends CordisContext {
    sandbox: {
      [key: string]: any;
      [key: symbol]: any;
      /** 宿主契约：dsh-sandbox-local 的 confine(argv, policy, signal?)
       * 是异步实现，返回 Promise；宿主 terminal-bash 以
       * `await sandbox.confine(argv, {...}, signal)` 调用。本插件的包装与之
       * 对齐同样是 async，并把 signal 透传给原实现。 */
      confine?: (argv: string[], policy: any, signal?: AbortSignal) => Promise<{ argv: string[]; [key: string]: any }>;
    };
    fs: {
      [key: string]: any;
      [key: symbol]: any;
      checkedTarget?: (...args: any[]) => Promise<any>;
    };
    sandboxPolicy: {
      /** 宿主契约:dsh-sandbox-policy 的 resolve() 是同步调用,返回普通
       * 对象而非 Promise。checkedTarget 包装依赖该同步性——若宿主改为
       * 异步,包装里 policy.mode 将是 undefined,额外目录在 fs 侧静默
       * 失效;升级 DSH 时请核对该签名。 */
      resolve(): { mode: string; workspaceRoot?: string };
    };
    // 宿主 settings 服务为 SettingsForms（Loader profile 条目的 Config
    // 表单投影）。本插件不声明 Config schema，卡片经
    // plugins.bundle.config slot 与 config gateway 读写，此处无需声明。
  }
}

// dsh-sandbox 与 node-addon-landlock-run 的类型不再手写声明：两包类型均在
// 依赖树内可解析（devDependencies / optionalDependencies），官方 .d.ts 是唯一
// 契约源——手写副本曾在官方漂移时把偏差藏过 typecheck（2026-10-24 审计结论）。

