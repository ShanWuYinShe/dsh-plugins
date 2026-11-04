/**
 * remote.ts — 插件配置的远程服务（设置页 UI 通过 ctx.remote.sandboxExtraRootsConfig 调用）。
 *
 * 远程服务面用官方标准装饰器声明：TypertRemoteService 的子类 + 具体方法上的
 * @Remote。@Remote 标记走 typert-protocol 的私有 descriptor，必须在**具体业务
 * 方法**上（不要包一层转发），并且 service key 是构造里的字符串字面量——
 * typert 生成器（@deepseek-ai/dsh-typert-generator）静态分析这三点，产出
 * ./typert（Host 工件）与 ./remote（Client 调用面）。本文件不再手写这些工件。
 *
 * 失败归一化（RULE-039）：失败点只抛官方 `RemoteError('<domain>/<reason>', …)`，
 * details 在本包 types.ts 的 `RemoteErrorDetailsMap` 声明合并；调用侧按 code
 * 判别（不要用 instanceof）。客户端把 code 映射到本地化文案。
 *
 * 持久化走官方 configEditor（写当前 profile 的 cordis.patch.yml 本行 config，
 * 与 Web 设置编辑器同一途径），见 ./config-store.js 的说明。
 *
 * @module @chaoset/sandbox-extra-roots/remote
 */

import type { Context } from '@deepseek-ai/cordis';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { resolveConfigPersist } from './config-store.js';
import { validateSandboxConfig } from './config-validate.js';
import type {
  SandboxExtraRootsConfig,
  SandboxExtraRootsGetResult,
  SandboxExtraRootsSetRequest,
  SandboxExtraRootsSetResult,
} from './types.js';

/**
 * 可通过设置页持久化的字段白名单。远端 codec 是 strict 输入（未知字段在 wire
 * 层已剥离），这里再挡一次：直接调用/未来新增字段时，请求里的未知字段不会
 * 被写进 profile patch（只并入白名单字段）。
 */
const WRITABLE_FIELDS = ['extraWritableRoots'] as const;

/** 取 set 请求里的白名单字段（其余字段一律丢弃）。 */
function writablePatch(partial: SandboxExtraRootsSetRequest): Partial<SandboxExtraRootsConfig> {
  const patch: Partial<SandboxExtraRootsConfig> = {};
  for (const field of WRITABLE_FIELDS) {
    const value = partial[field];
    if (value !== undefined) patch[field] = value;
  }
  return patch;
}

/** 把任意值转成可放 wire 的文本（循环引用等极端值不抛，供 details.value 使用）。 */
function stringifyValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** invalid-config 的 details：field 指出被拒绝的字段，value 保留原始值文本。 */
function invalidConfigDetails(partial: unknown): { field: string; value: string } {
  if (partial === null || typeof partial !== 'object' || Array.isArray(partial)) {
    return { field: 'config', value: stringifyValue(partial) };
  }
  const roots = (partial as { extraWritableRoots?: unknown }).extraWritableRoots;
  return { field: 'extraWritableRoots', value: stringifyValue(roots) };
}

/**
 * 配置远程服务：get() 返回当前生效配置；set(partial) 经官方 configEditor
 * 合并写入 profile patch，由 Loader 对账生效。通过
 * ctx.plugin(PluginConfigGateway, { config }) 注册。
 */
export class PluginConfigGateway extends TypertRemoteService {
  /** 当前生效配置（apply 收到的 cordis 注入 config；保存成功后原地更新）。 */
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
    // 形状与取值校验统一在 config-validate（非对象/非数组/相对路径/危险根都在
    // 这里拒绝）。校验函数本身保持纯抛 TypeError（便于单测直调）；在 Remote
    // 边界归一化为官方 RemoteError，客户端才能按 code 区分失败来源。
    try {
      validateSandboxConfig(partial);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new RemoteError('sandbox-extra-roots/invalid-config', error.message, invalidConfigDetails(partial));
    }
    const persist = resolveConfigPersist(this.pluginCtx);
    if (persist === undefined) {
      // 静默丢保存会让设置页显示成功而配置未持久化——如实失败（稳定 code，
      // 客户端映射为本地化部署限制提示，而不是网关折叠后的内部错误）。
      throw new RemoteError(
        'sandbox-extra-roots/config-unavailable',
        'config-editor is unavailable; configuration cannot be persisted in this deployment',
        {},
      );
    }
    const writable = writablePatch(partial);
    const saved = this.saves.then(async () => {
      // change 在编辑串行化 + Loader 对账后调用，参数是官方契约的两个合并基：
      // current（本行当前 raw config）与 inherited（继承层）。返回
      // {...inherited, ...current, ...writable}：既不丢用户在 patch 里手写的
      // 其它 key，也不把继承层固化成 override（与 inherited 深度相等时官方会
      // 删掉本行 config，见 dsh-config-editor 的 edit 实现）。
      const snapshot: { value?: SandboxExtraRootsConfig } = {};
      await persist.edit((current, inherited) => {
        const merged: Record<string, unknown> = { ...inherited, ...current, ...writable };
        const roots = merged.extraWritableRoots;
        // 实例快照只保留本插件字段（用户输入原样，canonical 化/危险根过滤由
        // Loader 对账后的 apply → normalizeRoots 负责）。
        snapshot.value = {
          extraWritableRoots: Array.isArray(roots) ? roots.filter((root): root is string => typeof root === 'string') : [],
        };
        return merged;
      });
      // 保存成功后更新实例快照：同一 fiber 内后续 get()/set() 立即看到新值，
      // 不再以 apply 时刻的旧快照为基（RULE-023）。
      if (snapshot.value !== undefined) this.config = snapshot.value;
    });
    this.saves = saved.then(() => {}, () => {});
    await saved;
    return { saved: true };
  }
}
