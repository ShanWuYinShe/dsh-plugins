import type { Context as CordisContext } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context extends CordisContext {
    sandbox: {
      [key: string]: any;
      [key: symbol]: any;
      /** 宿主契约（DSH 0.1.6 起）:dsh-sandbox-local 的 confine(argv, policy,
       * signal?) 是异步实现，返回 Promise；宿主 terminal-bash 以
       * `await sandbox.confine(argv, {...}, signal)` 调用。本插件的包装与之
       * 对齐同样是 async，并把 signal 透传给原实现。0.1.5 及更早宿主是同步
       * confine——本分支只跟随 0.1.6 线，不再兼容同步宿主。 */
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
    // DSH 0.1.7 移除了 settings namespace 注册体系：宿主 settings 服务现为
    // SettingsForms（Loader profile 条目的 Config 表单投影），不再有
    // register/installSection。本插件不声明 Config schema，卡片经
    // plugins.bundle.config slot 与 config gateway 读写，此处无需声明。
  }
}

declare module "@deepseek-ai/dsh-sandbox" {
  export const canonicalPath: (p: string) => string;
  export const writableRoots: (policy: any) => string[];
}

declare module "@deepseek-ai/node-addon-landlock-run" {
  export function launcherPath(): string;
}