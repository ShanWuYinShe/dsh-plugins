/**
 * policy-merge.ts — 把设置页配置的额外可写根并入官方 sandbox 策略。
 *
 * 0.2.2-rc.1 的 enforcer（Seatbelt / bwrap / Landlock / fs fence）全部从
 * `SandboxExecutionPolicy.additionalWritableRoots` 读取额外可写目录
 * （`@deepseek-ai/dsh-sandbox` 的 `writableRoots(policy)` 是唯一来源），官方
 * headless 的 `--add-dir` 也写同一字段。因此本插件不再包装私有面
 * `ctx.fs.checkedTarget`、不再改写 confine argv，只保留官方没有的那一层：
 * 设置页 UX、危险根校验与「当前真实存在的目录」过滤，然后把通过的根并入
 * 每次 `ctx.sandboxPolicy.resolve()` 的结果。
 *
 * 共享状态（引用计数）挂在底层 SandboxPolicyService 实例的 STATE symbol 上
 * （owner = service 实例）：Loader 行 reload 时新旧 entry 会短暂并存，多个
 * 挂载点共享同一份包装，最后一个 mount 退出才还原官方方法。
 *
 * @module @chaoset/sandbox-extra-roots/policy-merge
 */

import { symbols } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyRequest, SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { canon } from './roots.js'
import type { RootsFilter } from './roots-filter.js'

/** 包装状态标记：挂在底层 policy service 实例上，保证幂等与跨挂载点共享。 */
const STATE = Symbol('sandbox-extra-roots.policy-merge')

/** 官方 resolve 的方法面（显式 this：包装后仍以 service 实例为 this 调用原实现）。 */
type PolicyResolve = (this: SandboxPolicyService, request?: SandboxPolicyRequest) => SandboxExecutionPolicy

/** 一次挂载共享的包装状态；挂在底层 service 实例的 STATE symbol 上。 */
interface PolicyMergeState {
  /** 当前挂载点数量（Loader 热切换时新旧 entry 会短暂并存）。 */
  mounts: number
  /** 当前生效的额外可写根（配置期 canonical、去重、已过滤危险根）。 */
  extraRoots: readonly string[]
  /** 同一 key 只告警一次。 */
  warned: Set<string>
  /** 实例级目录存在性 TTL 缓存（owner: apply；行 reload 时整体换新）。 */
  rootsFilter: RootsFilter
  /** 当前 apply 的日志函数（reload 后旧 fiber 的 ctx 可能失效）。 */
  warn: (message: string) => void
  /** 包装是否已安装。 */
  wrapped: boolean
  /** 底层实例原本是否自有 resolve（自有属性 vs 原型方法）。 */
  hadOwn: boolean
  /** 底层实例原本的 resolve 实现。 */
  original: PolicyResolve | undefined
  /** 已安装的包装实现。 */
  installed: PolicyResolve | undefined
}

/** 带包装状态的 service 视图（computed symbol 键需要 unique symbol 常量）。 */
type PolicyServiceWithState = SandboxPolicyService & { [STATE]?: PolicyMergeState }

/** 一次 apply 持有的包装句柄；共享状态仍挂在 service 实例上。 */
export interface PolicyMerge {
  /** 挂载计数 +1；返回本挂载点的 disposer（最后一个退出时还原官方 resolve）。 */
  mount(): () => void
  /**
   * 安装/沿用 resolve 包装（幂等）。必须在 `ctx.effect(() => merge.mount())`
   * 登记之后调用：安装抛错时由 fiber dispose 回收挂载计数，不会留下无 owner
   * 的已安装包装。
   */
  install(): void
  /** 更新本次 apply 的生效根/目录缓存/日志函数（下一次 resolve 生效）。 */
  update(extraRoots: readonly string[], rootsFilter: RootsFilter, warn: (message: string) => void): void
}

/** 包装所需的装配依赖。 */
export interface PolicyMergeDeps {
  rootsFilter: RootsFilter
  warn: (message: string) => void
}

/**
 * 取底层 policy service：宿主若以 tracer 等 proxy 暴露服务，沿官方 registry
 * symbol 取原始实例，保证包装与还原作用在同一对象上。
 */
export function rawPolicyService(service: SandboxPolicyService | undefined): SandboxPolicyService {
  if (service === undefined || service === null) {
    throw new Error('sandbox-extra-roots: ctx.sandboxPolicy is unavailable; extra writable roots cannot be merged into the official sandbox policy')
  }
  const original = Reflect.get(service, symbols.original) as SandboxPolicyService | undefined
  return original ?? service
}

/** 取回或建立底层 service 实例上的共享包装状态。 */
export function policyMerge(service: SandboxPolicyService, deps: PolicyMergeDeps): PolicyMerge {
  const target = service as PolicyServiceWithState
  const state: PolicyMergeState = target[STATE] ?? (target[STATE] = {
    mounts: 0,
    extraRoots: [],
    warned: new Set<string>(),
    rootsFilter: deps.rootsFilter,
    warn: deps.warn,
    wrapped: false,
    hadOwn: false,
    original: undefined,
    installed: undefined,
  })
  return {
    mount(): () => void {
      state.mounts += 1
      return () => releasePolicyMerge(target, state)
    },
    install(): void {
      installPolicyMerge(target, state)
    },
    update(extraRoots: readonly string[], rootsFilter: RootsFilter, warn: (message: string) => void): void {
      // 行 reload 的短暂重叠窗口里旧包装仍生效：这里原地换成本次 apply 的
      // 生效根与目录缓存，下一次 resolve 即用「当前这一代配置」。
      state.extraRoots = extraRoots
      state.rootsFilter = rootsFilter
      state.warn = warn
    },
  }
}

/** 安装 resolve 包装（幂等；只在整个进程首次挂载时安装一次）。 */
function installPolicyMerge(target: PolicyServiceWithState, state: PolicyMergeState): void {
  if (state.wrapped) return
  if (typeof target.resolve !== 'function') {
    throw new Error('sandbox-extra-roots: ctx.sandboxPolicy.resolve is not a function on this host; extra writable roots cannot be merged into the official sandbox policy')
  }
  state.hadOwn = Object.hasOwn(target, 'resolve')
  state.original = target.resolve as PolicyResolve
  const installed: PolicyResolve = function resolveWithExtraRoots(
    this: SandboxPolicyService,
    request?: SandboxPolicyRequest,
  ): SandboxExecutionPolicy {
    const official = state.original
    if (official === undefined) throw new Error('sandbox-extra-roots: official sandbox policy resolve is not installed')
    return mergeExtraRoots(state, official.call(this, request))
  }
  state.installed = installed
  target.resolve = installed as SandboxPolicyService['resolve']
  state.wrapped = true
}

/** 释放一次挂载：最后一个挂载点退出时还原官方 resolve 并清空状态。 */
function releasePolicyMerge(target: PolicyServiceWithState, state: PolicyMergeState): void {
  state.mounts -= 1
  if (state.mounts > 0) return
  if (state.wrapped && target.resolve === state.installed) {
    if (state.hadOwn && state.original !== undefined) target.resolve = state.original as SandboxPolicyService['resolve']
    else Reflect.deleteProperty(target, 'resolve')
  }
  state.wrapped = false
  state.extraRoots = []
  delete target[STATE]
}

/**
 * 把生效额外根并入一次已解析的官方策略。无增量时**返回原引用**（不产生多余
 * 分配，也避免让不关心额外根的调用方看到对象身份变化）。
 */
function mergeExtraRoots(state: PolicyMergeState, policy: SandboxExecutionPolicy): SandboxExecutionPolicy {
  // 只有 workspace-write 消费额外根；read-only / danger-full-access 原样返回。
  if (policy.mode !== 'workspace-write' || state.extraRoots.length === 0) return policy
  const effective = effectiveExtraRoots(state)
  if (effective.length === 0) return policy
  const officialRoots = policy.additionalWritableRoots ?? []
  const officialSet = new Set(officialRoots)
  const additive = effective.filter((root) => !officialSet.has(root))
  if (additive.length === 0) return policy
  return { ...policy, additionalWritableRoots: Object.freeze([...officialRoots, ...additive]) }
}

/**
 * 本次调用真正可授予的额外根：
 *   1. 运行期身份校验——配置期已 canonical 化，`canon(root) !== root` 说明根被
 *      替换（符号链接交换/祖先替换）；官方 enforcement 对符号链接根会拒绝，
 *      这里提前剔除，避免一个被换掉的根把整条沙盒调用打挂；
 *   2. 真实存在目录过滤——官方 enforcement 把缺失/非目录根当配置错误拒绝，
 *      失效的缓存目录（工具被卸载等）不能因此打断所有沙盒操作。
 * 两层都 warnOnce，不按调用刷屏。
 */
function effectiveExtraRoots(state: PolicyMergeState): string[] {
  const stable: string[] = []
  for (const root of new Set(state.extraRoots)) {
    const physical = canon(root)
    if (physical === root) {
      stable.push(root)
      continue
    }
    warnOnce(state, `runtime-alias:${root}`, `extra writable root is no longer the physical path it was configured as (symlink swap?); not granting it to the official sandbox: ${root} -> ${physical}`)
  }
  return state.rootsFilter.existingDirectoryRoots(stable, state.warned, 'the official sandbox', state.warn)
}

/** 同一 key 只告警一次（消息统一加插件前缀）。 */
function warnOnce(state: PolicyMergeState, key: string, message: string): void {
  if (state.warned.has(key)) return
  state.warned.add(key)
  state.warn(`sandbox-extra-roots: ${message}`)
}
