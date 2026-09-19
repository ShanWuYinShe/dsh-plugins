import { createServer, get, request, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createProbeKey, workBuddyProbeHandler } from '../src/probe-route.js'

const KEY = 'k'.repeat(48)

async function mount(deps?: {
  probe?: (modelId: string) => Promise<{ state: string; reason?: string }>
  clear?: () => void
  refresh?: () => Promise<{ state: string; reason?: string }>
  setConsent?: (enabled: boolean) => void
}): Promise<{ server: Server; port: number; calls: string[] }> {
  const calls: string[] = []
  const handler = workBuddyProbeHandler({
    probe: async modelId => {
      calls.push(`probe:${modelId}`)
      return deps?.probe === undefined ? { state: 'ok' } : deps.probe(modelId)
    },
    clear: () => {
      calls.push('clear')
      deps?.clear?.()
    },
    refresh: deps?.refresh === undefined
      ? undefined
      : async () => {
        calls.push('refresh')
        return deps.refresh!()
      },
    setConsent: deps?.setConsent === undefined
      ? undefined
      : enabled => {
        calls.push(`consent:${String(enabled)}`)
        deps.setConsent!(enabled)
      },
  }, KEY)
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('no port')
  return { server, port: address.port, calls }
}

let mounted: { server: Server } | undefined

afterEach(async () => {
  await new Promise<void>(resolve => {
    if (mounted === undefined) { resolve(); return }
    mounted.server.close(() => resolve())
  })
  mounted = undefined
})

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, res => {
      let text = ''
      res.on('data', (chunk: Buffer) => { text += chunk.toString() })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
        } catch (error: unknown) {
          reject(error)
        }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

const AUTH = { 'x-workbuddy-probe-key': KEY, origin: 'http://127.0.0.1:3000' }

describe('workBuddyProbeHandler', () => {
  it('rejects GET, untrusted hosts, and wrong keys', async () => {
    const m = await mount()
    mounted = m
    const getStatus = await new Promise<number>(resolve => {
      get(`http://127.0.0.1:${m.port}`, res => resolve(res.statusCode ?? 0))
    })
    expect(getStatus).toBe(405)
    // No key
    expect((await post(m.port, { action: 'clear' }, { origin: 'http://127.0.0.1:9' })).status).toBe(403)
    // Wrong key
    expect((await post(m.port, { action: 'clear' }, { ...AUTH, 'x-workbuddy-probe-key': 'wrong' })).status).toBe(403)
    // Bad action
    expect((await post(m.port, { action: 'explode' }, AUTH)).status).toBe(400)
    expect(m.calls).toEqual([])
  })

  it('dispatches probe, clear, and refresh', async () => {
    const m = await mount({ refresh: async () => ({ state: 'ok' }) })
    mounted = m
    expect(await post(m.port, { action: 'probe', model: 'm1' }, AUTH)).toEqual({
      status: 200,
      json: { state: 'ok' },
    })
    expect(await post(m.port, { action: 'clear' }, AUTH)).toEqual({
      status: 200,
      json: { state: 'cleared' },
    })
    expect(await post(m.port, { action: 'refresh' }, AUTH)).toEqual({
      status: 200,
      json: { state: 'ok' },
    })
    expect(m.calls).toEqual(['probe:m1', 'clear', 'refresh'])
  })

  it('mints unique per-process keys', () => {
    expect(createProbeKey()).not.toBe(createProbeKey())
  })

  it('dispatches set-consent and rejects malformed payloads', async () => {
    const m = await mount({ setConsent: () => {} })
    mounted = m
    expect(await post(m.port, { action: 'set-consent', enabled: true }, AUTH)).toEqual({
      status: 200,
      json: { state: 'ok', enabled: true },
    })
    expect(await post(m.port, { action: 'set-consent', enabled: false }, AUTH)).toEqual({
      status: 200,
      json: { state: 'ok', enabled: false },
    })
    // 缺 enabled 或非布尔：形状校验拒绝，不触碰处理器。
    expect((await post(m.port, { action: 'set-consent' }, AUTH)).status).toBe(400)
    expect((await post(m.port, { action: 'set-consent', enabled: 'yes' }, AUTH)).status).toBe(400)
    expect(m.calls).toEqual(['consent:true', 'consent:false'])
  })

  it('answers 404 for set-consent when the handler has no consent hook', async () => {
    const m = await mount()
    mounted = m
    expect((await post(m.port, { action: 'set-consent', enabled: true }, AUTH)).status).toBe(404)
  })
})
