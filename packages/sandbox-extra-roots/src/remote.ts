/**
 * remote.ts — 插件配置的远程服务（设置页 UI 通过 ctx.remote.<svc> 调用）
 *
 * 加载器与标记机制（typert-protocol 惰性加载、markRemoteMethod、
 * runPendingMarks）在 ./typert-loader.js：那个文件与 session-archive 的同名
 * 文件**逐字相同**，由根 test/bundle.test.ts 的一致性锁保证（改一侧必须改
 * 另一侧）。本文件只保留本包特有的网关。
 *
 * 模块加载失败由 index.ts 的动态 import 捕获——核心功能不受影响，
 * 仅设置页 UI 的配置读写不可用。
 */

import type { Context } from "@deepseek-ai/cordis";
import type { ConfigStore } from "./config-store.js";
import { TypertRemoteService, markRemoteMethod, runPendingMarks } from "./typert-loader.js";

/**
 * 配置远程服务：get() 返回当前生效配置；set(partial) 持久化并热更新。
 * 通过 ctx.plugin(PluginConfigGateway, { store, serviceKey }) 注册。
 * @param ctx - 插件上下文。
 * @param config - { store: createConfigStore 返回的存储, serviceKey: 远程服务名 }。
 */
export class PluginConfigGateway extends TypertRemoteService {
  private store: ConfigStore;
  constructor(ctx: Context, config: { store: ConfigStore; serviceKey: string }) {
    super(ctx, config.serviceKey);
    runPendingMarks(this);
    this.store = config.store;
  }
  get() {
    return { config: this.store.effective() };
  }
  set(partial: Record<string, any>) {
    if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
      throw new TypeError("set expects a plain config object");
    }
    this.store.set(partial);
    return { saved: true };
  }
}
markRemoteMethod(PluginConfigGateway.prototype, "get");
markRemoteMethod(PluginConfigGateway.prototype, "set");
// 模块加载时立即执行标记（Object.create 模拟实例；构造函数里的 runPendingMarks 幂等保留无害）。
runPendingMarks(Object.create(PluginConfigGateway.prototype));
