import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createChildProcessTracker, type ChildProcessTracker } from '../src/child-processes.js'
import {
  executeOpenCodeTransportViaBun,
  getTransportScriptPath,
  isTransportWorkerProcess,
  resolveBunPath,
  runTransportWorker,
} from '../src/opencode-transport.js'
import {
  OpenCodeUpstreamClient,
  type OpenCodeTransportFn,
} from '../src/upstream-opencode.js'
import type { WorkBuddyCredential } from '../src/auth-types.js'

function makeCredential(overrides?: Partial<WorkBuddyCredential>): WorkBuddyCredential {
  return {
    accessToken: 'public',
    refreshToken: '',
    expiresAtMs: Date.now() + 100_000,
    domain: 'opencode.ai',
    uid: 'opencode-public',
    source: 'desktop',
    ...overrides,
  }
}

describe('OpenCode Bun 传输层 (Transport)', () => {
  const realBun = resolveBunPath()

  describe('resolveBunPath', () => {
    it('显式配置禁用标志时返回 undefined', () => {
      expect(resolveBunPath('disabled')).toBeUndefined()
      expect(resolveBunPath('none')).toBeUndefined()
      expect(resolveBunPath('off')).toBeUndefined()
    })

    it('环境变量配置禁用标志时返回 undefined', () => {
      const orig = process.env.BUN_PATH
      try {
        process.env.BUN_PATH = 'disabled'
        expect(resolveBunPath()).toBeUndefined()
      } finally {
        if (orig !== undefined) process.env.BUN_PATH = orig
        else delete process.env.BUN_PATH
      }
    })

    it('配置存在的文件路径时优先返回', () => {
      if (realBun) {
        expect(resolveBunPath(realBun)).toBe(realBun)
      }
      expect(resolveBunPath(process.execPath)).toBe(process.execPath)
    })

    it('环境变量 BUN_PATH 指向存在文件时正确返回', () => {
      expect(resolveBunPath(undefined, { BUN_PATH: process.execPath })).toBe(process.execPath)
      expect(resolveBunPath(undefined, { BUN_PATH: 'off' })).toBeUndefined()
    })

    it('环境变量 PATH 中包含 bun 时正确发现', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bun-path-test-'))
      try {
        const fakeBun = join(dir, 'bun')
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        expect(resolveBunPath(undefined, { BUN_PATH: '', PATH: `${dir}:/usr/bin` })).toBe(fakeBun)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('当 candidates 都不存在且 PATH 为空时返回 undefined', () => {
      expect(resolveBunPath(undefined, { BUN_PATH: '', PATH: '' }, '/non/existent/home/dir')).toBeUndefined()
    })

    it('当候选路径命中 .local/bin/bun 时返回候选路径', () => {
      const homeDir = mkdtempSync(join(tmpdir(), 'bun-home-test-'))
      try {
        const localBin = join(homeDir, '.local', 'bin')
        const fakeBun = join(localBin, 'bun')
        const { mkdirSync } = require('node:fs')
        mkdirSync(localBin, { recursive: true })
        writeFileSync(fakeBun, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        expect(resolveBunPath(undefined, { BUN_PATH: '', PATH: '' }, homeDir)).toBe(fakeBun)
      } finally {
        rmSync(homeDir, { recursive: true, force: true })
      }
    })

    it('配置或环境变量指向不存在路径时跳过并尝试后续候选', () => {
      expect(resolveBunPath('/non/existent/configured/path', { BUN_PATH: '/non/existent/env/path', PATH: '' }, '/non/existent/home')).toBeUndefined()
    })
  })

  describe('getTransportScriptPath', () => {
    it('返回合法的脚本路径', () => {
      const script = getTransportScriptPath()
      expect(script).toMatch(/opencode-transport\.(ts|js)$/)
    })
  })

  describe('isTransportWorkerProcess', () => {
    it('精确识别 __worker__ 入口参数', () => {
      expect(isTransportWorkerProcess(['bun', 'script.js', '__worker__'])).toBe(true)
      expect(isTransportWorkerProcess(['bun', 'script.js'])).toBe(false)
      expect(isTransportWorkerProcess([])).toBe(false)
      expect(isTransportWorkerProcess()).toBe(false)
    })
  })

  describe('runTransportWorker 单元测试', () => {
    it('正常流程读取 stdin 并发出 fetch 请求、写入元数据与流式响应', async () => {
      async function* mockStdin() {
        yield Buffer.from(JSON.stringify({
          url: 'https://example.com/api',
          headers: { 'x-header': 'val' },
          body: '{"ping":1}',
        }))
      }

      const written: string[] = []
      const mockStdout = {
        write: (data: string | Uint8Array) => {
          written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
          return true
        },
      }

      let exitCode: number | undefined
      const mockExit = (code: number) => {
        exitCode = code
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: 1\n\n'))
          controller.enqueue(new TextEncoder().encode('data: 2\n\n'))
          controller.close()
        },
      })

      const mockFetch: typeof fetch = async (input, init) => {
        expect(input).toBe('https://example.com/api')
        expect((init?.headers as Record<string, string>)['x-header']).toBe('val')
        return new Response(stream, {
          status: 200,
          statusText: 'OK',
          headers: { 'x-resp': 'ok' },
        })
      }

      await runTransportWorker(mockStdin(), mockStdout, mockFetch, mockExit)

      expect(exitCode).toBe(0)
      expect(written.length).toBeGreaterThanOrEqual(2)
      const meta = JSON.parse(written[0]!.trim())
      expect(meta.ok).toBe(true)
      expect(meta.status).toBe(200)
      expect(meta.headers['x-resp']).toBe('ok')
      expect(written.join('')).toContain('data: 1\n\ndata: 2\n\n')
    })

    it('正常流程处理无响应体情况', async () => {
      async function* mockStdin() {
        yield Buffer.from(JSON.stringify({
          url: 'https://example.com/api',
          headers: {},
          body: '',
        }))
      }

      const written: string[] = []
      const mockStdout = {
        write: (data: string | Uint8Array) => {
          written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
          return true
        },
      }

      let exitCode: number | undefined
      const mockExit = (code: number) => {
        exitCode = code
      }

      const mockFetch: typeof fetch = async () => {
        return new Response(null, {
          status: 204,
          statusText: 'No Content',
        })
      }

      await runTransportWorker(mockStdin(), mockStdout, mockFetch, mockExit)

      expect(exitCode).toBe(0)
      const meta = JSON.parse(written[0]!.trim())
      expect(meta.status).toBe(204)
    })

    it('异常输入或 fetch 抛错时写入 500 错误元数据并以 1 退出', async () => {
      async function* mockStdin() {
        yield Buffer.from('invalid-json{{{')
      }

      const written: string[] = []
      const mockStdout = {
        write: (data: string | Uint8Array) => {
          written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
          return true
        },
      }

      let exitCode: number | undefined
      const mockExit = (code: number) => {
        exitCode = code
      }

      await runTransportWorker(mockStdin(), mockStdout, fetch, mockExit)

      expect(exitCode).toBe(1)
      expect(written.length).toBe(1)
      const meta = JSON.parse(written[0]!.trim())
      expect(meta.ok).toBe(false)
      expect(meta.status).toBe(500)
    })

    it('fetch 抛出网络错误时写入 500 错误元数据', async () => {
      async function* mockStdin() {
        yield Buffer.from(JSON.stringify({ url: 'http://127.0.0.1:9', headers: {}, body: '' }))
      }
      const written: string[] = []
      const mockStdout = {
        write: (data: string | Uint8Array) => {
          written.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
          return true
        },
      }
      let exitCode: number | undefined
      const mockFetch: typeof fetch = async () => {
        throw new Error('Network offline')
      }
      await runTransportWorker(mockStdin(), mockStdout, mockFetch, (code) => { exitCode = code })
      expect(exitCode).toBe(1)
      expect(written[0]).toContain('Network offline')
    })

    it('正常流程处理字符串类型的 stdin chunk', async () => {
      async function* mockStdin() {
        yield JSON.stringify({ url: 'http://127.0.0.1', headers: {}, body: '' })
      }
      let exitCode: number | undefined
      const mockFetch: typeof fetch = async () => new Response(null, { status: 200 })
      await runTransportWorker(mockStdin(), { write: () => true }, mockFetch, (code) => { exitCode = code })
      expect(exitCode).toBe(0)
    })

    it('使用默认 exitFn 时能够正常退出', async () => {
      async function* mockStdin() {
        yield Buffer.from(JSON.stringify({ url: 'http://127.0.0.1', headers: {}, body: '' }))
      }
      const origExit = process.exit
      let exitCode: number | undefined
      process.exit = ((code?: number) => {
        exitCode = code
        return undefined as never
      }) as typeof process.exit
      try {
        const mockFetch: typeof fetch = async () => new Response(null, { status: 200 })
        await runTransportWorker(mockStdin(), { write: () => true }, mockFetch)
        expect(exitCode).toBe(0)
      } finally {
        process.exit = origExit
      }
    })
  })

  describe('executeOpenCodeTransportViaBun 分支与生命周期', () => {
    let tmpDir: string | undefined

    afterEach(() => {
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true })
        tmpDir = undefined
      }
    })

    it('在信号已中止时立刻返回 499 Client Closed Request', async () => {
      const controller = new AbortController()
      controller.abort()
      const res = await executeOpenCodeTransportViaBun({
        bunPath: realBun ?? '/usr/bin/false',
        url: 'http://127.0.0.1:9999',
        headers: {},
        body: '{}',
        signal: controller.signal,
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(499)
      expect(res.errorText).toContain('aborted')
    })

    it('当二进制路径不存在时返回 500 Spawn Error', async () => {
      const res = await executeOpenCodeTransportViaBun({
        bunPath: '/non/existent/path/to/bun_xyz_12345',
        url: 'http://127.0.0.1:9999',
        headers: {},
        body: '{}',
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(500)
      expect(['Spawn Error', 'Child Process Error']).toContain(res.statusText)
    })

    it('当二进制为目录引发 spawn 错误时返回 500 Child Process Error 并注销 signal 监听', async () => {
      const controller = new AbortController()
      const res = await executeOpenCodeTransportViaBun({
        bunPath: tmpdir(),
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
        signal: controller.signal,
      })
      expect(res.ok).toBe(false)
      expect(res.status).toBe(500)
      expect(res.statusText).toBe('Child Process Error')
    })

    it('当 worker 返回非 200 响应时正确收集错误体', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-err-worker.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ ok: false, status: 403, statusText: 'Forbidden' }) + '\\n');
        process.stdout.write('Access denied by upstream');
        process.exit(0);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(res.statusText).toBe('Forbidden')
      expect(res.errorText).toBe('Access denied by upstream')
    })

    it('当 worker 返回非 200 响应且无错误体时回退 statusText', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-err-nobody.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ ok: false, status: 403, statusText: 'Forbidden' }) + '\\n');
        process.exit(0);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(403)
      expect(res.errorText).toBe('Forbidden')
    })

    it('当 worker 输出非法 JSON 元数据行时回退 500 Invalid Worker Response', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-bad-meta.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write('not-json-line\\n');
        process.exit(0);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(500)
      expect(res.statusText).toBe('Invalid Worker Response')
    })

    it('当 worker 未输出换行即异常退出时返回 500 Worker Exited Unexpectedly', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-crash.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stderr.write('Fatal crash\\n');
        process.exit(2);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(500)
      expect(res.statusText).toBe('Worker Exited Unexpectedly')
      expect(res.errorText).toContain('Fatal crash')
    })

    it('当 worker 异常退出且无 stderr 时包含退出码', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-silent-crash.cjs')
      writeFileSync(
        scriptPath,
        `
        process.exit(3);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(500)
      expect(res.errorText).toBe('Worker exited with code 3')
    })

    it('流式取消时能够正常触发 cancel 清理', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-stream.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ ok: true, status: 200, statusText: 'OK' }) + '\\nchunk1\\n');
        setInterval(() => {}, 10000);
        `,
      )

      const tracker = createChildProcessTracker()
      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
        childProcesses: tracker,
      })

      expect(res.ok).toBe(true)
      if (res.body) {
        const reader = res.body.getReader()
        const chunk = await reader.read()
        expect(chunk.done).toBe(false)
        await reader.cancel()
      }
      await tracker.dispose()
    })

    it('流式运行期间 signal abort 能够正常中止', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-abort.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ ok: true, status: 200, statusText: 'OK' }) + '\\nchunk1\\n');
        setInterval(() => {}, 10000);
        `,
      )

      const controller = new AbortController()
      const tracker = createChildProcessTracker()
      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
        signal: controller.signal,
        childProcesses: tracker,
      })

      expect(res.ok).toBe(true)
      controller.abort()
      await tracker.dispose()
    })

    it('当 stdout 发生错误时流控制器捕获异常', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-stdout-err.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ ok: true, status: 200, statusText: 'OK' }) + '\\n');
        setInterval(() => {}, 1000);
        `,
      )

      let capturedChild: any
      const tracker: ChildProcessTracker = {
        track(child: any) {
          capturedChild = child
        },
        dispose: async () => {},
      }

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
        childProcesses: tracker,
      })

      expect(res.ok).toBe(true)
      const reader = res.body!.getReader()
      capturedChild.stdout.emit('error', new Error('Stdout stream broken'))
      await expect(reader.read()).rejects.toThrow('Stdout stream broken')
      capturedChild.kill('SIGKILL')
    })

    it('当 worker 正常写完退出时流能够正常读到 done', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-normal-end.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ ok: true, status: 200, statusText: 'OK' }) + '\\n');
        process.stdout.write('part 1\\n');
        process.stdout.write('part 2\\n');
        process.exit(0);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(true)
      if (res.body) {
        const reader = res.body.getReader()
        let received = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          received += new TextDecoder().decode(value)
        }
        expect(received).toContain('part 1')
        expect(received).toContain('part 2')
      }
    })

    it('当 worker 输出分块并在后续块中出现换行时能够正确拼装元数据', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-split-meta.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write('{"ok":true');
        setTimeout(() => {
          process.stdout.write(',"status":200,"statusText":"OK"}\\nhello world');
          process.exit(0);
        }, 10);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const chunk = await reader.read()
      expect(new TextDecoder().decode(chunk.value)).toBe('hello world')
    })

    it('当 worker 返回非 200 响应且 body 为空但有 stderr 时优先使用 stderrText', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-stderr-only.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stderr.write('Upstream gateway error\\n');
        process.stdout.write(JSON.stringify({ ok: false, status: 502, statusText: 'Bad Gateway' }) + '\\n');
        process.exit(0);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(502)
      expect(res.errorText).toBe('Upstream gateway error')
    })

    it('当 worker 元数据未指定 statusText 与 ok 时回退默认计算值', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-minimal-meta.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ status: 200 }) + '\\nbody');
        process.exit(0);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      expect(res.statusText).toBe('OK')
    })

    it('当 worker 元数据 status 为 400 且未指定 statusText 与 ok 时回退 Error', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-err-meta.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ status: 400 }) + '\\n');
        process.exit(0);
        `,
      )

      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
      })

      expect(res.ok).toBe(false)
      expect(res.status).toBe(400)
      expect(res.statusText).toBe('Error')
      expect(res.errorText).toBe('Error')
    })

    it('当流取消后再次触发 abort 信号时安全幂等处理', async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'bun-transport-test-'))
      const scriptPath = join(tmpDir, 'mock-long-run.cjs')
      writeFileSync(
        scriptPath,
        `
        process.stdout.write(JSON.stringify({ ok: true, status: 200 }) + '\\ninitial');
        setInterval(() => { process.stdout.write('tick'); }, 100);
        `,
      )

      const controller = new AbortController()
      const res = await executeOpenCodeTransportViaBun({
        bunPath: process.execPath,
        scriptPath,
        url: 'http://127.0.0.1',
        headers: {},
        body: '{}',
        signal: controller.signal,
      })

      expect(res.ok).toBe(true)
      await res.body!.cancel()
      controller.abort()
    })
  })

  describe('OpenCodeUpstreamClient 与 Transport 联动', () => {
    it('通过自定义 transport 成功流式返回数据并透传', async () => {
      const mockTransport: OpenCodeTransportFn = async (opts) => {
        expect(opts.headers['x-opencode-client']).toBe('cli')
        expect(opts.headers['x-session-id']).toBeDefined()
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n'))
            controller.close()
          },
        })
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: stream,
        }
      }

      const client = new OpenCodeUpstreamClient({
        transport: mockTransport,
      })
      const cred = makeCredential()
      const result = await client.chatStream(cred, JSON.stringify({ model: 'longcat-2.5-free', messages: [] }))
      expect(result.ok).toBe(true)
      if (result.ok && result.response.body) {
        const reader = result.response.body.getReader()
        const chunk = await reader.read()
        expect(new TextDecoder().decode(chunk.value)).toContain('pong')
      }
    })

    it('通过自定义 transport 遇到 429 报错时注入 Bun 指南说明', async () => {
      const mockTransport: OpenCodeTransportFn = async () => {
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers(),
          body: null,
          errorText: '{"error":{"type":"FreeUsageLimitError"}}',
        }
      }

      const client = new OpenCodeUpstreamClient({
        transport: mockTransport,
      })
      const cred = makeCredential()
      const result = await client.chatStream(cred, JSON.stringify({ model: 'longcat-2.5-free', messages: [] }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.status).toBe(429)
        expect(result.message).toContain('FreeUsageLimitError')
        expect(result.message).toContain('Cloudflare TLS 指纹校验')
      }
    })
  })

  describe('本地 HTTP 端到端真实 Bun 进程集成测试', () => {
    let server: ReturnType<typeof createServer> | undefined

    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()))
        server = undefined
      }
    })

    it.runIf(realBun !== undefined)('通过真实 Bun worker 完成 HTTP 请求并流式透传', async () => {
      let receivedHeaders: Record<string, string | string[] | undefined> = {}
      let receivedBody = ''

      server = createServer((req, res) => {
        receivedHeaders = req.headers
        const chunks: Buffer[] = []
        req.on('data', c => chunks.push(c))
        req.on('end', () => {
          receivedBody = Buffer.concat(chunks).toString('utf8')
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'X-Custom-Server': 'test-server',
          })
          res.write('data: {"chunk":1}\n\n')
          setTimeout(() => {
            res.write('data: {"chunk":2}\n\n')
            res.end()
          }, 20)
        })
      })

      await new Promise<void>((resolve) => {
        server!.listen(0, '127.0.0.1', () => resolve())
      })

      const port = (server.address() as AddressInfo).port
      const tracker = createChildProcessTracker()

      const res = await executeOpenCodeTransportViaBun({
        bunPath: realBun!,
        url: `http://127.0.0.1:${port}/test`,
        headers: {
          'x-test-header': 'hello-bun',
        },
        body: JSON.stringify({ ping: true }),
        childProcesses: tracker,
      })

      expect(res.ok).toBe(true)
      expect(res.status).toBe(200)
      expect(res.headers.get('x-custom-server')).toBe('test-server')
      expect(receivedHeaders['x-test-header']).toBe('hello-bun')
      expect(JSON.parse(receivedBody)).toEqual({ ping: true })

      if (res.body) {
        const reader = res.body.getReader()
        let text = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          text += new TextDecoder().decode(value)
        }
        expect(text).toContain('chunk":1')
        expect(text).toContain('chunk":2')
      }
    })
  })
})
