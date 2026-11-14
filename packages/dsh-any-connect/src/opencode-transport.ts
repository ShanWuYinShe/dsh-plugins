/**
 * opencode-transport.ts — OpenCode 免费通道 TLS 指纹穿透传输层（Bun Bridge）。
 *
 * OpenCode 免费通道（Cloudflare）强制核验 TLS ClientHello 指纹（BoringSSL / Bun / Chromium）。
 * Node.js 内置 OpenSSL 的指纹会被网关拦截并返回 429 FreeUsageLimitError。
 *
 * 本模块实现：
 * 1. 自动发现系统 Bun 运行时路径（Config / BUN_PATH / ~/.bun/bin/bun / PATH）；
 * 2. 在存在 Bun 时，通过受控短命子进程（融合 ChildProcessTracker 与 AbortSignal）透明执行上游请求；
 * 3. 实时将流式响应字节无缝桥接为标准 Web ReadableStream；
 * 4. 在无 Bun 时平滑降级至 Node 原生 fetch，并在遇到 429 时提供明确指导文案。
 *
 * @module dsh-any-connect/opencode-transport
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcessTracker } from './child-processes.js'

function isExplicitlyDisabled(val?: string): boolean {
  return typeof val === 'string' && /^(disabled|none|off)$/i.test(val.trim())
}

/**
 * 自动定位系统中的 Bun 二进制文件路径。
 */
export function resolveBunPath(
  configured?: string,
  customEnv: NodeJS.ProcessEnv = process.env,
  customHome: string = homedir(),
): string | undefined {
  if (configured && configured.trim() !== '') {
    if (isExplicitlyDisabled(configured)) return undefined
    const candidate = configured.trim()
    if (existsSync(candidate)) return candidate
  }
  const envBun = customEnv.BUN_PATH?.trim()
  if (envBun) {
    if (isExplicitlyDisabled(envBun)) return undefined
    if (existsSync(envBun)) return envBun
  }
  const pathDirs = (customEnv.PATH || '').split(':')
  for (const dir of pathDirs) {
    if (!dir) continue
    const full = join(dir, 'bun')
    if (existsSync(full)) return full
  }
  const candidates = [
    join(customHome, '.bun', 'bin', 'bun'),
    join(customHome, '.local', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return undefined
}

/**
 * 获取传输脚本自身的绝对路径（兼容 .ts 源码测试与 .js 构建产物）。
 */
export function getTransportScriptPath(): string {
  return fileURLToPath(import.meta.url)
}

export interface BunTransportOptions {
  bunPath: string
  scriptPath?: string
  url: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
  childProcesses?: ChildProcessTracker
}

export interface BunTransportResult {
  ok: boolean
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  errorText?: string
}

/**
 * 通过 Bun 子进程发起具备 BoringSSL 指纹的 HTTPS 请求并流式透传数据。
 */
export function executeOpenCodeTransportViaBun(options: BunTransportOptions): Promise<BunTransportResult> {
  const {
    bunPath,
    scriptPath = getTransportScriptPath(),
    url,
    headers,
    body,
    signal,
    childProcesses,
  } = options

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({
        ok: false,
        status: 499,
        statusText: 'Client Closed Request',
        headers: new Headers(),
        body: null,
        errorText: 'Request was aborted before execution',
      })
      return
    }

    const child = spawn(bunPath, [scriptPath, '__worker__'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    childProcesses?.track(child)

    let cleanedUp = false
    const cleanupProcess = () => {
      if (cleanedUp) return
      cleanedUp = true
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.kill('SIGTERM')
    }

    const removeSignalListener = () => {
      signal?.removeEventListener('abort', cleanupProcess)
    }

    signal?.addEventListener('abort', cleanupProcess, { once: true })

    child.on('error', (err) => {
      removeSignalListener()
      resolve({
        ok: false,
        status: 500,
        statusText: 'Child Process Error',
        headers: new Headers(),
        body: null,
        errorText: err.message,
      })
    })

    const payload = JSON.stringify({ url, headers, body })
    child.stdin?.write(payload, 'utf8', () => {
      child.stdin?.end()
    })

    let stdoutBuffer = Buffer.alloc(0)
    let metaParsed = false
    let stderrText = ''

    child.stderr?.on('data', (c: Buffer) => {
      stderrText += c.toString('utf8')
    })

    const onData = (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk])
      const newlineIdx = stdoutBuffer.indexOf(0x0a) // '\n'
      if (newlineIdx === -1) {
        return
      }

      metaParsed = true
      child.stdout?.removeListener('data', onData)
      const line = stdoutBuffer.subarray(0, newlineIdx).toString('utf8')
      const remaining = stdoutBuffer.subarray(newlineIdx + 1)

      let meta: { ok?: boolean; status?: number; statusText?: string; headers?: Record<string, string> } = {}
      try {
        meta = JSON.parse(line)
      } catch {
        meta = { ok: false, status: 500, statusText: 'Invalid Worker Response' }
      }

      const status = typeof meta.status === 'number' ? meta.status : 500
      const ok = typeof meta.ok === 'boolean' ? meta.ok : (status >= 200 && status < 300)
      const statusText = meta.statusText || (ok ? 'OK' : 'Error')
      const respHeaders = new Headers(meta.headers ?? {})

      if (!ok) {
        let errBody = remaining.toString('utf8')
        child.stdout?.on('data', (c: Buffer) => { errBody += c.toString('utf8') })
        child.once('close', () => {
          removeSignalListener()
          resolve({
            ok: false,
            status,
            statusText,
            headers: respHeaders,
            body: null,
            errorText: errBody.trim() || stderrText.trim() || statusText,
          })
        })
        return
      }

      let controllerClosed = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (remaining.length > 0) {
            controller.enqueue(new Uint8Array(remaining))
          }
          child.stdout?.on('data', (c: Buffer) => {
            if (!controllerClosed) {
              controller.enqueue(new Uint8Array(c))
            }
          })
          child.stdout?.on('end', () => {
            removeSignalListener()
            if (!controllerClosed) {
              controllerClosed = true
              try { controller.close() } catch {}
            }
          })
          child.stdout?.on('error', (err) => {
            removeSignalListener()
            if (!controllerClosed) {
              controllerClosed = true
              try { controller.error(err) } catch {}
            }
          })
        },
        cancel() {
          controllerClosed = true
          removeSignalListener()
          cleanupProcess()
        },
      })

      resolve({
        ok: true,
        status,
        statusText,
        headers: respHeaders,
        body: stream,
      })
    }

    child.stdout?.on('data', onData)
    child.once('close', (code) => {
      if (!metaParsed) {
        removeSignalListener()
        resolve({
          ok: false,
          status: 500,
          statusText: 'Worker Exited Unexpectedly',
          headers: new Headers(),
          body: null,
          errorText: stderrText.trim() || `Worker exited with code ${code}`,
        })
      }
    })
  })
}

/**
 * 传输工作进程的执行体（仅在以 `__worker__` 参数被 Bun 拉起时执行）。
 * 可选入参用于单测时直接注入 mock 避免子进程环境不可测。
 */
export async function runTransportWorker(
  stdin: AsyncIterable<Buffer | string> = process.stdin,
  stdout: { write: (data: string | Uint8Array) => boolean } = process.stdout,
  fetchFn: typeof fetch = fetch,
  exitFn: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
    const rawInput = Buffer.concat(chunks).toString('utf8')
    const req = JSON.parse(rawInput) as {
      url: string
      headers: Record<string, string>
      body: string
    }

    const res = await fetchFn(req.url, {
      method: 'POST',
      headers: req.headers,
      body: req.body,
    })

    const headerObj: Record<string, string> = {}
    for (const [k, v] of res.headers.entries()) {
      headerObj[k] = v
    }

    stdout.write(JSON.stringify({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: headerObj,
    }) + '\n')

    if (res.body) {
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        stdout.write(value)
      }
    }
    exitFn(0)
  } catch (err) {
    stdout.write(JSON.stringify({
      ok: false,
      status: 500,
      statusText: String(err),
      headers: {},
    }) + '\n')
    exitFn(1)
  }
}

/**
 * 判断当前进程是否作为独立的 Bun 传输 Worker 被拉起。
 */
export function isTransportWorkerProcess(argv: string[] = process.argv): boolean {
  return argv[2] === '__worker__'
}

/* v8 ignore start */
if (isTransportWorkerProcess()) {
  void runTransportWorker()
}
/* v8 ignore stop */
