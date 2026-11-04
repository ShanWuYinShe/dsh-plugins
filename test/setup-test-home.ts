/**
 * 测试环境隔离：每个测试文件一份全新的 `DSH_HOME`。
 *
 * 历史上全仓共用一个 `.workwork/dsh-test-home`，任何测试写下的凭据、目录缓存、
 * 状态域都可能被别的测试读到——同一份代码是否变红取决于执行顺序、并行度与
 * 上一次跑留下的残留，这是不可接受的测试不确定性来源。
 *
 * 这里在**每个测试文件开始前**清空一份 worker 专属目录并指给 `DSH_HOME`：
 * - 同一 worker 内测试文件串行执行，先清空即「每个文件都从空状态开始」；
 * - 不同 worker 的目录互不相交，并行时也不会互相污染；
 * - 文件结束（afterAll）与进程退出（exit）双重兜底清理，跨运行不留残留。
 *
 * 依赖 DSH_HOME 的用例仍可按需在自身 beforeEach 里覆盖该变量。
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll } from 'vitest'

const root = resolve(import.meta.dirname ?? '.', '..')
const workerKey = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
const home = join(root, '.workwork', 'test-homes', `${process.pid}-${workerKey}`)

function cleanup(): void {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败不影响测试结论 */ }
}

rmSync(home, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home

afterAll(cleanup)
process.once('exit', cleanup)
