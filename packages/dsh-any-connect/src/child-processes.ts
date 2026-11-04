/**
 * child-processes.ts — 在途 helper 子进程的登记与回收。
 *
 * 只做一件事：让「短命 helper 子进程」有 owner。`execFile` 的 `timeout` 只管
 * 单步子进程的上限（发现 3s / 解密助手 10s）；插件卸载或宿主退出时若还有一轮
 * 发现或解密助手在跑，必须 kill 并等它真的退出——否则 disposal 没有到达
 * quiescence（RULE-045），子进程在宿主退出后仍可能读写文件（RULE-047：teardown
 * 时 kill 并 await）。
 *
 * 刻意保持零依赖（只 import node 类型）：发现链路（desktop-discovery）与解密
 * 助手（desktop-at-rest-key）共用同一份实现，由组合根（runtime）持有实例并在
 * dispose 时收尾。
 *
 * @module dsh-any-connect/child-processes
 */

import type { ChildProcess } from 'node:child_process'

/** 在途子进程登记器（见模块头）。 */
export interface ChildProcessTracker {
  /**
   * 登记一个刚启动的子进程。必须在 spawn 的同一拍调用（close 事件注册发生在
   * 它退出之前），否则 dispose 等不到它的 close。
   */
  track(child: ChildProcess): void
  /**
   * kill 全部在途子进程并等它们的 close；dispose 后新登记的子进程会被立即
   * kill。幂等。
   */
  dispose(): Promise<void>
}

export function createChildProcessTracker(): ChildProcessTracker {
  /** child → 它的 close promise（登记时即建立，避免「先退出后挂监听」的竞态）。 */
  const live = new Map<ChildProcess, Promise<void>>()
  let disposed = false

  function track(child: ChildProcess): void {
    if (disposed) {
      child.kill()
      return
    }
    if (live.has(child)) return
    const closed = new Promise<void>(resolve => {
      child.once('close', () => {
        live.delete(child)
        resolve()
      })
    })
    live.set(child, closed)
  }

  async function dispose(): Promise<void> {
    if (disposed) {
      await Promise.allSettled([...live.values()])
      return
    }
    disposed = true
    const pending = [...live.entries()]
    for (const [child] of pending) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    await Promise.allSettled(pending.map(([, closed]) => closed))
  }

  return { track, dispose }
}
