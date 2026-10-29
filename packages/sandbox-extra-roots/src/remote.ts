/**
 * remote.ts — 插件配置的远程服务（设置页 UI 通过 ctx.remote.sandboxExtraRootsConfig 调用）。
 *
 * 远程服务面用官方标准装饰器声明：TypertRemoteService 的子类 + 具体方法上的
 * @Remote。@Remote 标记走 typert-protocol 的私有 descriptor，必须在**具体业务
 * 方法**上（不要包一层转发），并且 service key 是构造里的字符串字面量——
 * typert 生成器（@deepseek-ai/dsh-typert-generator）静态分析这三点，产出
 * ./typert（Host 工件）与 ./remote（Client 调用面）。本文件不再手写这些工件。
 *
 * 持久化走官方 configEditor（写当前 profile 的 cordis.patch.yml 本行 config，
 * 与 Web 设置编辑器同一途径），见 ./config-store.js 的说明。
 *
 * @module @chaoset/sandbox-extra-roots/remote
 */

import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolveConfigPersist } from './config-store.js';
import { validateSandboxConfig } from './config-validate.js';
import type {
  SandboxExtraRootsConfig,
  SandboxExtraRootsGetResult,
  SandboxExtraRootsSetRequest,
  SandboxExtraRootsSetResult,
} from './types.js';

/**
 * 配置远程服务：get() 返回当前生效配置；set(partial) 经官方 configEditor
 * 合并写入 profile patch，由 Loader 对账生效。通过
 * ctx.plugin(PluginConfigGateway, { config }) 注册。
 */
export class PluginConfigGateway extends TypertRemoteService {
  /** 当前生效配置（apply 收到的 cordis 注入 config）。 */
  private config: SandboxExtraRootsConfig;
  private pluginCtx: Context;
  /** 保存串行化：提交按调用顺序落盘，前一笔失败不阻塞后续。 */
  private saves: Promise<void>;

  /**
   * @param ctx - 插件上下文。
   * @param config - { config: 插件生效 config 引用 }。
   */
  constructor(ctx: Context, config: { config: SandboxExtraRootsConfig }) {
    super(ctx, 'sandboxExtraRootsConfig');
    this.config = config.config;
    this.pluginCtx = ctx;
    this.saves = Promise.resolve();
  }

  /** 读取当前生效配置。 */
  @Remote('get')
  get(): SandboxExtraRootsGetResult {
    return { config: { ...this.config } };
  }

  /**
   * 校验并保存部分配置（走官方 configEditor，写当前 profile 的 patch 层）。
   * @param partial - 要覆盖的配置字段；相对路径与危险根会被拒绝。
   */
  @Remote('set')
  async set(partial: SandboxExtraRootsSetRequest): Promise<SandboxExtraRootsSetResult> {
    // 形状与取值校验统一在 config-validate（非对象/非数组/相对路径/危险根都在这里拒绝）。
    validateSandboxConfig(partial);
    const persist = resolveConfigPersist(this.pluginCtx);
    if (persist === undefined) {
      // 静默丢保存会让设置页显示成功而配置未持久化——如实失败。
      throw new Error('config-editor is unavailable; configuration cannot be persisted in this deployment');
    }
    const next = { ...this.config, ...partial };
    const saved = this.saves.then(() => persist.edit(() => next));
    this.saves = saved.then(() => {}, () => {});
    await saved;
    return { saved: true };
  }
}
