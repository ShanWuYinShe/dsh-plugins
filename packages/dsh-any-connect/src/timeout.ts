/**
 * 宿主 deadline 抽象（静态 import `@deepseek-ai/dsh-timeout`）。
 *
 * 为什么可以直接静态 import 宿主包（2026-10-29 适配 DSH 0.2.2-alpha.2 时核实）：
 * 外部插件由宿主 profile runner 加载，runner 的 runtime resolution 会把安装侧
 * 依赖（dsh-timeout 是安装图里的包）补给它，Host 与插件 import 同一导出时
 * 共享同一模块实例（宿主注记 2026-09-08 desktop-bundled-runtime-and-external-plugins；
 * host-repo packages/boot/app-boot/src/profile.ts 的 collectInstallationScopePackages
 * 对安装 anchor 做 deps+peers+optionalDeps 全图 BFS，命中即作为 installation 条目）。
 * 因此这里不再需要「动态 import + 本地同语义回退」：那套双路径是旧宿主
 * 「产物只带 dependencies、静态 import 宿主包会炸」假设下的兼容实现，
 * 现在既多余（运行时永远拿得到宿主实现），又让超时原因出现两种类型。
 *
 * devDependencies 里的 dsh-timeout 只服务类型检查/构建/测试；正式安装时由宿主
 * 提供同一份模块（见 package.json 的 devDependencies 注释面即本段）。
 *
 * 返回的 handle 把宿主的 `[Symbol.dispose]` 包成普通 `dispose()`，调用方无需
 * 感知 disposable 协议（tsconfig 的 lib 已含 esnext.disposable）。
 *
 * @module dsh-any-connect/timeout
 */

import { deadline } from '@deepseek-ai/dsh-timeout'

/** 可释放的融合信号：上游取消 OR 超时任一触发即 abort，dispose 拆 timer。 */
export interface DeadlineHandle {
  signal: AbortSignal
  dispose(): void
}

/**
 * 融合上游取消与超时的信号（宿主 dsh-timeout 的 deadline）。
 *
 * 保留 async 外壳仅为调用方零改动（各处本就 await）；实现是同步的：
 * deadline 立即建 timer，超时原因即宿主 `TimeoutReason`，消费方按 reason.code
 * 分类即可（与宿主同一 taxonomy）。
 */
export async function deadlineSignal(upstream: AbortSignal | undefined, timeoutMs: number, code: string): Promise<DeadlineHandle> {
  // Host Deadline 的释放方法是 [Symbol.dispose]（lib 需 esnext.disposable，
  // 见 tsconfig.base.json）；这里包一层普通 dispose，调用方无感知。
  const handle = deadline(upstream, timeoutMs, code)
  return { signal: handle.signal, dispose: () => handle[Symbol.dispose]() }
}

/** 在融合信号下跑一段工作并保证拆 timer：JSON 短读等“取 signal 回调”形态专用。 */
export async function withTimeout<T>(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
  code: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const handle = await deadlineSignal(upstream, timeoutMs, code)
  try {
    return await fn(handle.signal)
  } finally {
    handle.dispose()
  }
}
