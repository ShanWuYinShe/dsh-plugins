import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createChildProcessTracker } from '../src/child-processes.js'

/**
 * 在途 helper 子进程回收（RULE-047，AC-04）：
 * dispose 必须 kill 登记的句柄**并等它真的退出**，而不是只发信号就返回。
 */

const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

function spawnLongLived(): ChildProcess {
  // 一个永不主动退出的真实子进程（与 helper 同形态：活着直到被 kill）。
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  children.push(child)
  return child
}

describe('createChildProcessTracker', () => {
  it('dispose kill 登记的调用并等到 close；幂等', async () => {
    const tracker = createChildProcessTracker()
    const child = spawnLongLived()
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    tracker.track(child)
    expect(child.exitCode, 'dispose 之前子进程不应已退出').toBeNull()

    await tracker.dispose()
    await closed
    expect(child.exitCode !== null || child.signalCode !== null, 'dispose 返回时子进程必须已退出').toBe(true)

    // 幂等：第二次调用不再挂起、不抛错。
    await expect(tracker.dispose()).resolves.toBeUndefined()
  })

  it('dispose 之后登记的子进程立即被 kill', async () => {
    const tracker = createChildProcessTracker()
    await tracker.dispose()
    const child = spawnLongLived()
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    tracker.track(child)
    await closed
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})
