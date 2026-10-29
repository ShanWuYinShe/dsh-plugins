/**
 * apply.ts — 插件主体：包装 sandbox/fs 并接配置热更新。
 *
 * 包装安装与共享挂载生命周期在 wrap.ts；argv 改写与危险根复查在
 * confine-runners.ts；本模块只做配置解析、状态装配与 Remote 服务注册。
 *
 * 官方依赖（@deepseek-ai/dsh-sandbox 等）一律静态导入：宿主的外部插件运行时
 * 解析保证单实例，没有 createRequire 多级 fallback 与模块求值期 await。
 *
 * @module @chaoset/sandbox-extra-roots/apply
 */

import type { Context } from '@deepseek-ai/cordis'
import { clearDirExistCache } from './roots-filter.js'
import { normalizeRoots } from './config-validate.js'
import { DEFAULT_CONFIG } from './plugin-config.js'
import { getLandlockRuntime } from './landlock-exec.js'
import { ORIGINAL } from './roots.js'
import { PluginConfigGateway } from './remote.js'
import type { SandboxExtraRootsConfig } from './types.js'
import {
  installConfineWrapper,
  installFsWrapper,
  mountState,
  rawService,
  releaseMount,
  type ConfineMountState,
  type MountState,
} from './wrap.js'

export async function apply(ctx: Context, config?: Partial<SandboxExtraRootsConfig>): Promise<void> {
  // fail-safe：初始化失败只记录，绝不让本插件拖垮 harness（host 层挂载时
  // entry 异常会导致进程启动失败）。
  try {
    const rawSandbox = rawService(ctx.sandbox, ORIGINAL)
    // ctx.fs 的官方 Context 增强来自本包未依赖的 @deepseek-ai/dsh-fs：按实例访问。
    const rawFs = rawService((ctx as unknown as { fs: unknown }).fs, ORIGINAL)
    const landlockRuntime = await getLandlockRuntime()

    // 共享状态（跨挂载点）：引用计数 + 包装句柄 + 当前生效的额外目录。
    const sandboxState = mountState<ConfineMountState>(rawSandbox, () => ({
      mounts: 0,
      extraRoots: [],
      warned: new Set<string>(),
      wrapped: false,
      hadOwn: false,
      original: null,
      installed: null,
      checkedProfile: false,
      profileDrifted: false,
    }))
    sandboxState.mounts += 1
    const fsState = mountState<MountState>(rawFs, () => ({
      mounts: 0,
      extraRoots: [],
      warned: new Set<string>(),
      wrapped: false,
      hadOwn: false,
      original: null,
      installed: null,
    }))
    fsState.mounts += 1

    // 卸载计数：在继续初始化之前登记，后续 setup 失败也由本 fiber 负责递减；
    // 最后一次退出才还原包装。
    ctx.effect(() => () => {
      releaseMount(rawSandbox, sandboxState, 'confine')
      releaseMount(rawFs, fsState, 'checkedTarget')
    })

    const warn = (message: string) => ctx.logger?.warn?.(message)
    // 生效配置：defaults 与 cordis 注入的 patch config（含 profile patch 里的
    // 用户 override——设置页保存经官方 configEditor 写入，由 Loader 对账后
    // reload 本行使新配置在这里生效）。配置热更新即行 reload：目录存在性缓存
    // 在每次 apply 重建时整体失效，保证按真实文件系统判定。
    const cfg: SandboxExtraRootsConfig = { ...DEFAULT_CONFIG, ...(config ?? {}) }
    clearDirExistCache()
    sandboxState.extraRoots = normalizeRoots(cfg, warn)
    fsState.extraRoots = sandboxState.extraRoots

    // 任一包装已在本实例上安装过（apply 重跑/多挂载点）时沿用，不重复包装。
    if (!sandboxState.wrapped) installConfineWrapper(rawSandbox, { ctx, state: sandboxState, landlockRuntime, warn })
    if (!fsState.wrapped) installFsWrapper(rawFs, { ctx, state: fsState, warn })

    // 可选服务（设置页 UI）：排在核心包装之后，且独立 fail-safe——gateway
    // 失败不影响包装。远程配置服务：typert 工件由官方生成器产出并随
    // package.json 的 ./typert 导出给宿主 typert-loader；此处只注册服务实例。
    try {
      ctx.plugin(PluginConfigGateway, { config: cfg })
    } catch (error) {
      ctx.logger?.warn?.(`sandbox-extra-roots: settings gateway failed (core sandbox extension unaffected): ${(error as Error)?.message ?? String(error)}`)
    }
  } catch (error) {
    ctx.logger?.warn?.(`sandbox-extra-roots: init failed: ${(error as Error)?.message ?? String(error)}`)
  }
}
