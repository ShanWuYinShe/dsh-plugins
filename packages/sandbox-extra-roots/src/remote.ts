/**
 * remote.ts — 插件配置的远程服务（设置页 UI 通过 ctx.remote.<svc> 调用）
 *
 * 加载器与标记机制（typert-protocol 惰性加载、markRemoteMethod、
 * runPendingMarks）在 ./typert-loader.js：那个文件与 session-archive 的同名
 * 文件**逐字相同**，由根 test/bundle.test.ts 的一致性锁保证（改一侧必须改
 * 另一侧）。本文件只保留本包特有的网关。
 *
 * 持久化走官方 configEditor（写当前 profile 的 cordis.patch.yml 本行
 * config，与 Web 设置编辑器同一途径），见 ./config-store.js 的说明。
 * 模块加载失败由 index.ts 的动态 import 捕获——核心功能不受影响，
 * 仅设置页 UI 的配置读写不可用。
 */

import type { Context } from "@deepseek-ai/cordis";
import { resolveConfigPersist } from "./config-store.js";
import { validateSandboxConfig } from "./config-validate.js";
import { TypertRemoteService, markRemoteMethod, runPendingMarks } from "./typert-loader.js";

/**
 * 配置远程服务：get() 返回当前生效配置；set(partial) 经官方 configEditor
 * 合并写入 profile patch，由 Loader 对账生效。通过
 * ctx.plugin(PluginConfigGateway, { config, serviceKey }) 注册。
 * @param ctx - 插件上下文。
 * @param config - { config: 插件生效 config 引用（apply 收到的 cordis 注入），
 *   serviceKey: 远程服务名 }。
 */
export class PluginConfigGateway extends TypertRemoteService {
  private config: Record<string, any>;
  private pluginCtx: Context;
  /** 保存串行化：提交按调用顺序落盘，前一笔失败不阻塞后续。 */
  private saves: Promise<void>;
  constructor(ctx: Context, config: { config: Record<string, any>; serviceKey: string }) {
    super(ctx, config.serviceKey);
    runPendingMarks(this);
    this.config = config.config;
    this.pluginCtx = ctx;
    this.saves = Promise.resolve();
  }
  get() {
    return { config: { ...this.config } };
  }
  async set(partial: Record<string, any>) {
    if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
      throw new TypeError("set expects a plain config object");
    }
    validateSandboxConfig(partial);
    const persist = resolveConfigPersist(this.pluginCtx);
    if (persist === undefined) {
      // 静默丢保存会让设置页显示成功而配置未持久化——如实失败。
      throw new Error("config-editor is unavailable; configuration cannot be persisted in this deployment");
    }
    const next = { ...this.config, ...partial };
    const saved = this.saves.then(() => persist.edit(() => next));
    this.saves = saved.then(() => {}, () => {});
    await saved;
    return { saved: true };
  }
}
markRemoteMethod(PluginConfigGateway.prototype, "get");
markRemoteMethod(PluginConfigGateway.prototype, "set");
// 模块加载时立即执行标记（Object.create 模拟实例；构造函数里的 runPendingMarks 幂等保留无害）。
runPendingMarks(Object.create(PluginConfigGateway.prototype));
