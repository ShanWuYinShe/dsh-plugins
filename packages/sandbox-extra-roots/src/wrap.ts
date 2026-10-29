/**
 * wrap.ts — sandbox / fs 两个宿主服务的包装安装与共享挂载状态。
 *
 * apply 包装 ctx.sandbox.confine（bash 侧按 runner 追加额外可写根）与
 * ctx.fs.checkedTarget（fs fence 放行额外根）。两个包装共享同一套挂载生命周期：
 * 状态挂在被包装的底层实例的 STATE symbol 上（同一底层实例被多个挂载点共享时
 * 引用计数），最后一个挂载点退出才还原原方法。
 *
 * 本模块只做装配；argv 改写与危险根复查在 confine-runners.ts，路径规范/分类在
 * roots.ts / config-validate.ts。
 *
 * @module @chaoset/sandbox-extra-roots/wrap
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { isPathUnder, seatbeltProfileArgs } from './common.js'
import { bindMountArgv, bindMountGrant, safeRuntimeRoots, seatbeltArgv, type ConfineRunnerDeps } from './confine-runners.js'
import { existingDirectoryRoots } from './roots-filter.js'
import { STATE, canon } from './roots.js'
import type { LandlockRuntime } from './landlock-exec.js'

/** 被包装的宿主服务实例（方法面按实例字符串/符号键访问：confine / checkedTarget / resolve / STATE）。 */
export type WrappedService = Record<string | symbol, any>

/** 一次挂载共享的包装状态；挂在底层实例的 STATE symbol 上。 */
export interface MountState {
  /** 当前挂载点数量（Loader 热切换时新旧 entry 会短暂并存）。 */
  mounts: number
  /** 当前生效的额外可写根（canonical、去重、已过滤危险根）。 */
  extraRoots: string[]
  /** 同一 key 只告警一次。 */
  warned: Set<string>
  /** 包装是否已安装。 */
  wrapped: boolean
  /** 底层实例原本是否自有该方法（自有属性 vs 原型方法）。 */
  hadOwn: boolean
  /** 底层实例原本的方法实现。 */
  original: any
  /** 已安装的包装实现。 */
  installed: any
}

/** confine 包装额外的 Seatbelt profile 漂移自检状态。 */
export interface ConfineMountState extends MountState {
  /** 是否已做过一次官方 profile 自检。 */
  checkedProfile: boolean
  /** 官方 profile 形状是否已漂移（漂移后永久放弃重建）。 */
  profileDrifted: boolean
}

/** 取底层实例（宿主以 Symbol 标记原始服务时沿标记取）。 */
export function rawService(service: unknown, original: symbol): WrappedService {
  const marker = service as { [key: symbol]: WrappedService | undefined }
  return marker[original] ?? (service as WrappedService)
}

/** 取回或建立底层实例上的包装状态。 */
export function mountState<S extends MountState>(target: WrappedService, create: () => S): S {
  return target[STATE] ?? (target[STATE] = create())
}

/** 卸载一次挂载：最后一个挂载点退出时还原原方法并清空状态。 */
export function releaseMount(target: WrappedService, state: MountState, method: string): void {
  state.mounts -= 1
  if (state.mounts > 0) return
  if (state.wrapped && target[method] === state.installed) {
    if (state.hadOwn) target[method] = state.original
    else delete target[method]
  }
  state.installed = null
  state.wrapped = false
  state.extraRoots = []
  try { delete target[STATE] } catch {}
}

/** 构造"同一 key 只告警一次"的 warnOnce（消息统一加插件前缀）。 */
function warnOnceFactory(ctx: Context, warned: Set<string>): (key: string, message: string) => void {
  return (key, message) => {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger?.warn?.(`sandbox-extra-roots: ${message}`)
  }
}

/** confine 包装的装配依赖。 */
export interface ConfineWrapDeps {
  ctx: Context
  state: ConfineMountState
  landlockRuntime: LandlockRuntime | null
  warn: (message: string) => void
}

/**
 * 包装 sandbox.confine：官方实现先执行（额外根只在官方结果上追加），
 * 再按 runner（Seatbelt/bwrap/Landlock/Windows ACL）注入额外可写根。
 */
export function installConfineWrapper(target: WrappedService, deps: ConfineWrapDeps): void {
  const { ctx, state, landlockRuntime, warn } = deps
  const warnOnce = warnOnceFactory(ctx, state.warned)
  state.hadOwn = Object.hasOwn(target, 'confine')
  state.original = target.confine
  // confine 是异步实现（SandboxProvider.confine 返回 Promise，terminal-bash
  // 以 await + signal 调用）：包装必须同样是 async 并把 signal 透传给原实现，
  // 否则 wrapped 是 Promise、wrapped.argv 为 undefined，每次 bash 执行都抛
  // TypeError。
  const installedConfine = async function confineWithExtraRoots(
    this: unknown,
    argv: readonly string[],
    policy: SandboxExecutionPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    const wrapped: ConfinedArgv = await state.original.call(this, argv, policy, signal)
    if (policy?.mode !== 'workspace-write') return wrapped
    if (state.extraRoots.length === 0) return wrapped
    // 每次调用重新 canonical 化（与官方 writableRoots 对 workspaceRoot 的
    // 姿态一致）：符号链接重定向后，下一次 confine 立即跟随新目标，不必等
    // 配置重新加载。跟随之后必须复查危险根：重定向目标可能是 "/" 或
    // homedir（沙盒内符号链接交换），运行期一律剔除。
    const roots = safeRuntimeRoots(
      [...new Set(state.extraRoots.map(canon))],
      state.warned,
      'bash commands',
      warn,
    )
    const runnerDeps: ConfineRunnerDeps = {
      warnOnce,
      checkSeatbeltDrift: (runnerPolicy, profile) => {
        if (state.profileDrifted) return true
        if (!state.checkedProfile) {
          state.checkedProfile = true
          try {
            const official = seatbeltProfileArgs(runnerPolicy, [])
            if (official[1] !== profile) {
              state.profileDrifted = true
              ctx.logger?.warn?.('sandbox-extra-roots: official seatbelt profile shape changed; refusing to rebuild it — bash-side extra roots stay OFF (the fs fence still grants them). Check common.ts seatbeltProfileArgs against dsh-sandbox-local.')
            }
          } catch {}
        }
        return state.profileDrifted
      },
    }
    const a: readonly string[] = wrapped.argv
    // Seatbelt：官方 argv 为 [sandbox-exec, -p, <profile>, --, ...inner]。
    if (a[1] === '-p' && typeof a[2] === 'string' && a[2].includes('(version 1)')) {
      const rebuilt = seatbeltArgv(a, roots, policy, runnerDeps)
      if (rebuilt !== null) wrapped.argv = rebuilt
      return wrapped
    }
    // bwrap：在 -- 前插入 --bind <root> <root>（后挂载覆盖 --ro-bind / /）。
    // 插入集合与 Seatbelt 对齐：官方根 ∪ 额外根去重后减去官方已授予的
    // 部分；且只授予当前真实存在的目录，缺失 root 会让 bwrap 启动失败。
    if (a[0] === 'bwrap') {
      const rebuilt = bindMountArgv(a, roots, policy, state.warned, warn, warnOnce, bindMountGrant, 'bwrap')
      if (rebuilt !== null) wrapped.argv = rebuilt
      return wrapped
    }
    // Landlock：在 -- 前插入官方 grantArgs 产出的授权片段（--rw <root>）。
    // 与 bwrap 同一插入集合；同样只授予存在的目录（launcher 把 unopenable
    // grant root 视为失败）。
    if (landlockRuntime !== null && a[0] === landlockRuntime.exec) {
      const rebuilt = bindMountArgv(a, roots, policy, state.warned, warn, warnOnce, (root) => landlockRuntime.grantArgs({ readWrite: [root] }), 'landlock')
      if (rebuilt !== null) wrapped.argv = rebuilt
      return wrapped
    }
    // Windows ACL runner：argv 层面无法追加额外根目录，仅告警一次。
    // 只检查 runner 参数段（-- 之前），避免误匹配用户命令里的 --workspace。
    const separator = a.indexOf('--')
    const runnerArgs = separator === -1 ? a : a.slice(0, separator)
    if (runnerArgs.includes('--workspace')) {
      warnOnce('windows-acl', '[sandbox-extra-roots] windows-acl runner cannot grant extra writable roots; bash-side extra roots are not granted on Windows (the fs fence still grants them)')
      return wrapped
    }
    warnOnce(`unknown-runner:${String(a[0])}`, `[sandbox-extra-roots] unknown sandbox runner argv[0] "${String(a[0])}"; bash-side extra writable roots are not granted`)
    return wrapped
  }
  target.confine = installedConfine
  state.installed = installedConfine
  state.wrapped = true
}

/** fs fence 解析出的目标（官方 FsTarget 带 canonical targetKey；本包只消费这两个字段）。 */
interface ResolvedFsTarget {
  displayPath: string
  targetKey: string
}

/** fs fence 包装的装配依赖。 */
export interface FsWrapDeps {
  ctx: Context
  state: MountState
  warn: (message: string) => void
}

/**
 * 包装 fs.checkedTarget：官方白名单拒绝后，再检查目标是否落在本插件配置的
 * 额外根目录内；官方逻辑永远优先执行（升级不因复制实现而漂移）。
 */
export function installFsWrapper(service: WrappedService, deps: FsWrapDeps): void {
  const { ctx, state, warn } = deps
  state.hadOwn = Object.hasOwn(service, 'checkedTarget')
  state.original = service.checkedTarget
  const installedCheckedTarget = async function checkedTargetWithExtraRoots(
    this: unknown,
    target: ResolvedFsTarget,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<ResolvedFsTarget> {
    try {
      return await state.original.call(this, target, sandboxPolicy)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'FS_SANDBOX_DENIED') throw error
      // 宿主契约：sandboxPolicy.resolve() 同步返回普通对象（见官方
      // @deepseek-ai/dsh-sandbox-policy 的 SandboxPolicyService.resolve）。
      // 这里不能 await——若宿主未来异步化，policy.mode 会是 undefined，
      // 恒走 rethrow 分支，fs 侧额外目录将静默失效；升级时请核对该签名。
      // 策略解析本身失败（服务缺失/契约变化）时保持官方拒绝语义：rethrow
      // 原始 FS_SANDBOX_DENIED，绝不让插件内部异常盖过沙盒拒绝。
      let policy: SandboxExecutionPolicy
      try {
        policy = sandboxPolicy ?? ctx.sandboxPolicy.resolve()
      } catch {
        throw error
      }
      if (policy.mode !== 'workspace-write') throw error
      // 显式绑定到底层实例：宿主若以解绑形式调用 checkedTarget
      // （const ct = fs.checkedTarget; ct(...)），this.resolve 会是 undefined
      // 并抛 TypeError，把官方的 FS_SANDBOX_DENIED 拒绝文本替换成插件内部
      // 异常。resolve 与后续匹配自身的异常（契约漂移如 displayPath 缺失、
      // canonical 化/祖先链 stat 遇 EACCES 等）同样不能外泄盖过官方拒绝——
      // 整体兜底 rethrow 原始 FS_SANDBOX_DENIED，失败姿态保持 fail-closed。
      try {
        const fresh: ResolvedFsTarget = await service.resolve.call(service, target.displayPath)
        // 与 bash 侧（bwrap/Landlock）对齐：只对当前真实存在的目录放行，
        // 消除"文件工具放行、bash 拒绝"或反向的分叉；每次调用重新
        // canonical 化，符号链接重定向后立即跟随（同 confine 路径）。
        // 跟随之后同样复查危险根（bash 侧 safeRuntimeRoots 的镜像，
        // 沙盒内符号链接交换不能让 fs 侧单侧放行全盘）。
        const roots = existingDirectoryRoots(
          safeRuntimeRoots(
            [...new Set(state.extraRoots.map(canon))],
            state.warned,
            'the fs fence',
            warn,
          ),
          state.warned,
          'the fs fence',
          warn,
        )
        for (const root of roots) {
          if (await isPathUnder(fresh.targetKey, root)) return fresh
        }
      } catch (innerError) {
        if (innerError === error) throw error
        ctx.logger?.warn?.(`sandbox-extra-roots: fs-fence extra-root check failed (${(innerError as Error)?.message ?? String(innerError)}); keeping the official denial`)
        throw error
      }
      throw error
    }
  }
  service.checkedTarget = installedCheckedTarget
  state.installed = installedCheckedTarget
  state.wrapped = true
}
