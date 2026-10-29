import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * 发布产物 lib/bin.js 的自包含回归。
 *
 * bin 由宿主 loader 之外的独立 node 进程启动，宿主包的 runtime resolution 不覆盖
 * 它：源码里静态 import 的 @deepseek-ai/* 必须由构建期 esbuild 打包内联
 * （scripts/build.mjs 阶段 4），否则用户在 profile 里执行 `node lib/bin.js --help`
 * 会直接 ERR_MODULE_NOT_FOUND——正是这里要守住的故障。
 *
 * 判据都读**真实构建产物**：test:ci 先跑 build，所以拿到的是新鲜 bundle。lib/bin.js
 * 缺失或仍是 tsc 裸产物时**大声失败**而不是静默跳过：跳过等于让这个发布缺口的
 * 回归永远绿。
 */

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(PKG_ROOT, 'lib', 'bin.js')
const BUILD_HINT = 'lib/bin.js 缺失或仍是 tsc 裸产物：先运行 bun run build（scripts/build.mjs 阶段 4）'

const temps: string[] = []

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

/** 读构建产物；缺失时给出可操作的失败信息（而不是 ENOENT 栈）。 */
function binSource(): string {
  try {
    return readFileSync(BIN, 'utf8')
  } catch {
    throw new Error(BUILD_HINT)
  }
}

/** 产物里所有模块说明符（静态 import / export from / dynamic import / require）。 */
function importSpecifiers(code: string): string[] {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/gu,
    /\bimport\s*['"]([^'"]+)['"]/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/gu,
  ]
  const found = new Set<string>()
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) found.add(specifier)
    }
  }
  return [...found].sort()
}

/** 隔离的临时目录：既做 cwd 也做 DSH_HOME，不碰真实 ~/.dsh。 */
function isolatedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-any-connect-bin-'))
  temps.push(dir)
  return dir
}

/** 桌面端 / ZCode 凭据显式指向不存在路径：本机是否登录过不影响断言。 */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_HOME: home,
    WORKBUDDY_AUTH_FILE: join(home, 'no-such-workbuddy-auth.info'),
    WORKBUDDY_AI_AUTH_FILE: join(home, 'no-such-workbuddy-ai-auth.info'),
    ZCODE_AUTH_FILE: join(home, 'no-such-zcode-credentials.json'),
  }
}

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: isolatedEnv(cwd) })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('lib/bin.js 自包含 CLI', () => {
  it('首行保留 shebang（产物可直接执行）', () => {
    expect(binSource().split('\n', 1)[0]).toBe('#!/usr/bin/env node')
  })

  it('只 import node: 内建模块（宿主包已内联，无裸 import）', () => {
    const specifiers = importSpecifiers(binSource())
    // 至少要扫到 node: 内建 import；一个都没有说明扫描面失效（判据空转）。
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((specifier) => !specifier.startsWith('node:')), BUILD_HINT).toEqual([])
  })

  it('在任意空目录下 --help 可用', () => {
    const cwd = isolatedDir()
    const result = runCli(['--help'], cwd)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Usage: dsh-any-connect')
  })

  it('--json status 输出可解析 JSON，version 仍读包根 package.json', () => {
    const cwd = isolatedDir()
    const result = runCli(['status', '--json'], cwd)
    // 隔离环境里必然未登录：退出码 1（业务结果，不是崩溃），stdout 必须是纯 JSON。
    expect(result.status, result.stderr).toBe(1)
    const manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as { version: string }
    const report = JSON.parse(result.stdout) as { package?: unknown; status?: unknown; version?: unknown }
    expect(report.package).toBe('dsh-any-connect')
    // bundle 里的 createRequire(import.meta.url) 仍要解析到包根 package.json，
    // 而不是打成 '0.0.0-dev'（version.ts 读失败时的回落值）。
    expect(report.version, 'version 必须来自包根 package.json').toBe(manifest.version)
    expect(report.status).toBe('signed-out')
  })
})
