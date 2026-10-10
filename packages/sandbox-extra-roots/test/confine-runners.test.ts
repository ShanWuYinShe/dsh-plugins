/**
 * confine runner 分支锁：seatbelt 分隔符错位与 Windows ACL runner 的
 * fail-closed 分支此前零覆盖——正是"漂移自检检不出、必须在这里挡"的关键分支。
 *
 * 平台相关值全部取自运行时（mkdtemp 真实目录、canonicalPath），用例平台无关。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { canonicalPath, seatbeltProfileArgs } from '../src/common.js'

const fakePlatform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')

const WS = mkdtempSync(join(tmpdir(), 'ser-cr-ws-'))

function makeFsMock() {
  return {
    async resolve(displayPath: string) { return { targetKey: displayPath } },
    async checkedTarget(_target: any): Promise<{ targetKey: string }> {
      throw Object.assign(new Error('FS_SANDBOX_DENIED'), { code: 'FS_SANDBOX_DENIED' })
    },
  }
}

function makeCtx(sandbox: any, fs: any): any {
  const disposers: Array<() => void> = []
  return {
    sandbox,
    fs,
    disposers,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: WS }) },
    logger: { warn: () => {} },
    effect(fn: () => any) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    plugin() {},
  }
}

afterEach(() => {
  fakePlatform.mockReturnValue('linux')
})

describe('confine runner 成功路径：分隔符必须保留', () => {
  it('seatbelt 追加额外根后仍保留 -- 分隔符，且 inner 命令原样', async () => {
    // 2026-10-10 实测发现的漏网：重建 argv 用 a.slice(sbSep + 1) 取 inner，
    // 却忘了把 "--" 自己补回去 —— sandbox-exec 收到 [-p, profile, bash, -c, ...]
    // 会把 bash 当 profile/参数解析，macOS 上每条受限 bash 命令都跑不了。
    // 旧的 fail-closed 用例只覆盖"拒绝重建"，成功路径零覆盖，遂漏。
    const fakeHome = mkdtempSync(join(tmpdir(), 'ser-cr-homes-'))
    const existing = mkdtempSync(join(tmpdir(), 'ser-cr-roots-'))
    process.env.HOME = fakeHome
    process.env.DSH_HOME = fakeHome
    try {
      const sandboxMock = {
        async confine(argv: string[], _policy: any) {
          return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
        },
      }
      const ctx = makeCtx(sandboxMock, makeFsMock())
      await apply(ctx, { extraWritableRoots: [existing] })
      const policy = { mode: 'workspace-write', workspaceRoot: WS }
      const official = seatbeltProfileArgs(policy, [])
      const profile = official[1]
      if (typeof profile !== 'string') throw new Error('seatbeltProfileArgs 形状变化')
      const argv = ['sandbox-exec', '-p', profile, '--', 'bash', '-c', 'echo hi']
      const out = await sandboxMock.confine(argv, policy)
      // 分隔符保留
      expect(out.argv).toContain('--')
      // 位置与非分隔符元素都与官方一致
      expect(out.argv.indexOf('--')).toBe(3)
      expect(out.argv[0]).toBe('sandbox-exec')
      expect(out.argv[1]).toBe('-p')
      expect(out.argv.slice(4)).toEqual(['bash', '-c', 'echo hi'])
      // 额外根确实进了 profile
      expect(String(out.argv[2])).toContain(canonicalPath(existing))
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(existing, { recursive: true, force: true })
    }
  })
})

describe('confine runner fail-closed 分支', () => {
  it('seatbelt 分隔符不在位置 3（profile 与 -- 之间多出参数）：保持官方 argv 原样', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'ser-cr-home-'))
    const existing = mkdtempSync(join(tmpdir(), 'ser-cr-root-'))
    process.env.HOME = fakeHome
    process.env.DSH_HOME = fakeHome
    try {
      const sandboxMock = {
        async confine(argv: string[], _policy: any) {
          return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
        },
      }
      const ctx = makeCtx(sandboxMock, makeFsMock())
      await apply(ctx, { extraWritableRoots: [existing] })
      // profile 文本与官方一致（过漂移自检），但 -- 前多了一个参数。
      const official = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: WS }, [])
      const profile = official[1]
      if (typeof profile !== 'string') throw new Error('seatbeltProfileArgs 形状变化')
      const drifted = ['sandbox-exec', '-p', profile, '--extra-flag', '--', 'bash', '-c', 'x']
      const out = await sandboxMock.confine(drifted, { mode: 'workspace-write', workspaceRoot: WS })
      expect(out.argv).toEqual(drifted)
      expect(out.argv).not.toContain(canonicalPath(existing))
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(existing, { recursive: true, force: true })
    }
  })

  it('Windows ACL runner（--workspace 在 runner 参数段）：bash 侧不追加、argv 原样', async () => {
    fakePlatform.mockReturnValue('win32')
    const fakeHome = mkdtempSync(join(tmpdir(), 'ser-cr-homew-'))
    const existing = mkdtempSync(join(tmpdir(), 'ser-cr-rootw-'))
    process.env.HOME = fakeHome
    process.env.DSH_HOME = fakeHome
    try {
      const sandboxMock = {
        async confine(argv: string[], _policy: any) {
          return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
        },
      }
      const ctx = makeCtx(sandboxMock, makeFsMock())
      await apply(ctx, { extraWritableRoots: [existing] })
      const argv = ['C:\\runner\\acl-run.exe', '--workspace', WS, '--', 'cmd', '/c', 'dir']
      const out = await sandboxMock.confine(argv, { mode: 'workspace-write', workspaceRoot: WS })
      expect(out.argv).toEqual(argv)
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(existing, { recursive: true, force: true })
    }
  })
})
