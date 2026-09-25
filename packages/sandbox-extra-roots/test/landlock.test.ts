/**
 * Landlock runner 路径的测试:分支只在 process.platform === "linux" 且
 * @deepseek-ai/node-addon-landlock-run 可加载时激活,macOS/CI 环境二者
 * 都不可得——平台 getter 与 loadLandlock 双 mock 后,分支逻辑(--rw 插入
 * 位置、存在性过滤、fail-closed)可在任意平台验证。mock 独立成文件,
 * 避免泄漏到 seatbelt/bwrap 的既有用例。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { canonicalPath } from '../src/common.js'

const fakePlatform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')

vi.mock('../src/common.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/common.js')>()
  return {
    ...actual,
    loadLandlock: async () => ({ launcherPath: () => '/fake/landlock-runner' }),
  }
})

const WS = mkdtempSync(join(tmpdir(), "ser-ll-ws-"))

function makeFsMock() {
  return {
    async resolve(displayPath: string) { return { targetKey: displayPath } },
    async checkedTarget(_target: any): Promise<{ targetKey: string }> {
      throw Object.assign(new Error("FS_SANDBOX_DENIED"), { code: "FS_SANDBOX_DENIED" })
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
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: WS }) },
    logger: { warn: () => {} },
    effect(fn: () => any) {
      const dispose = fn()
      if (typeof dispose === "function") disposers.push(dispose)
      return dispose
    },
    plugin() {},
  }
}

afterEach(() => {
  fakePlatform.mockReturnValue("linux")
})

describe("sandbox-extra-roots host (Landlock, platform-mocked)", () => {
  it("在 -- 前插入 --rw,只授予存在的目录", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ser-ll-home-"))
    const existing = mkdtempSync(join(tmpdir(), "ser-ll-root-"))
    const missing = join(fakeHome, "missing-root")
    process.env.HOME = fakeHome
    process.env.DSH_HOME = fakeHome
    try {
      const sandboxMock = {
        async confine(argv: string[], _policy: any) {
          return { argv, enforcement: "full", denialSignatures: [], runnerFailureRules: [] }
        },
      }
      const ctx = makeCtx(sandboxMock, makeFsMock())
      await apply(ctx, { extraWritableRoots: [existing, missing] })
      const out = await sandboxMock.confine(
        ["/fake/landlock-runner", "--foo", "bar", "--", "bash", "-c", "x"],
        { mode: "workspace-write", workspaceRoot: WS },
      )
      const pre = out.argv.slice(0, out.argv.indexOf("--"))
      expect(pre.filter((x: string) => x === "--rw")).toHaveLength(1)
      expect(pre).toContain(canonicalPath(existing))
      expect(pre).not.toContain(canonicalPath(missing))
      // runner 原生参数(--foo bar)与 inner 命令原样保留。
      expect(out.argv).toContain("--foo")
      expect(out.argv[out.argv.length - 1]).toBe("x")
    } finally {
      process.env.HOME = fakeHome
      process.env.DSH_HOME = fakeHome
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(existing, { recursive: true, force: true })
    }
  })

  it("argv 无 -- 分隔符时放弃插入(fail-closed)", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ser-ll-home2-"))
    const existing = mkdtempSync(join(tmpdir(), "ser-ll-root2-"))
    process.env.HOME = fakeHome
    process.env.DSH_HOME = fakeHome
    try {
      const sandboxMock = {
        async confine(argv: string[], _policy: any) {
          return { argv, enforcement: "full", denialSignatures: [], runnerFailureRules: [] }
        },
      }
      const ctx = makeCtx(sandboxMock, makeFsMock())
      await apply(ctx, { extraWritableRoots: [existing] })
      const out = await sandboxMock.confine(
        ["/fake/landlock-runner", "--foo", "bar"],
        { mode: "workspace-write", workspaceRoot: WS },
      )
      // 无分隔符 = 契约漂移:保持官方 argv 原样,不加任何 --rw。
      expect(out.argv).toEqual(["/fake/landlock-runner", "--foo", "bar"])
    } finally {
      process.env.HOME = fakeHome
      process.env.DSH_HOME = fakeHome
      rmSync(fakeHome, { recursive: true, force: true })
      rmSync(existing, { recursive: true, force: true })
    }
  })
})
