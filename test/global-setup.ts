/**
 * 测试套件级清理：只清「陈旧」的隔离 home，绝不动正在并发运行的目录。
 *
 * 每个测试文件由 `setup-test-home.ts` 分配自己进程专属的目录（键含 worker
 * pid），因此**同一 worktree 里并发跑两个 vitest 进程时目录天然不冲突**。
 * 本文件只负责兜底异常中断（如超时被杀）留下的残留：mtime 超过 1 小时的
 * 才删，且删除失败（并发进程正在用/正在删）一律忽略——清理不是测试结论的
 * 一部分，绝不能因为清理而让套件启动失败。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 超过该时长的目录视为异常中断残留（正常结束由各文件的 afterAll 自清理）。 */
const STALE_MS = 60 * 60 * 1000

export default function globalSetup(): void {
  const parent = join(resolve(import.meta.dirname ?? '.', '..'), '.workwork', 'test-homes')
  let entries: string[]
  try {
    entries = readdirSync(parent)
  } catch {
    return // 目录还不存在：首次运行。
  }
  const now = Date.now()
  for (const name of entries) {
    const path = join(parent, name)
    try {
      if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      // 并发运行的进程可能正在创建/删除同名目录：忽略，不影响本次运行。
    }
  }
}
