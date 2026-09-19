import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkBuddyCatalog } from '../src/catalog.js'
import type { ProbeSender } from '../src/probe.js'
import { WorkBuddyProbeService } from '../src/probe-service.js'
import { WorkBuddyProbeStore, fingerprintModel } from '../src/probe-store.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
})

const CREDENTIAL = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: Date.now() + 3600_000,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop' as const,
}

function undeclaredCatalog(): WorkBuddyCatalog {
  const catalog = new WorkBuddyCatalog()
  catalog.set([{
    id: 'probe-me',
    name: 'Probe Me',
    contextWindow: 1000,
    maxTokens: 100,
    supportsImages: false,
    reasoning: { supports: true, onlyReasoning: true, defaultEffort: 'high', canDisableThinking: false },
  }])
  return catalog
}

function declaredCatalog(): WorkBuddyCatalog {
  const catalog = new WorkBuddyCatalog()
  catalog.set([{
    id: 'probe-me', name: 'P', contextWindow: 1, maxTokens: 1, supportsImages: false,
    reasoning: { supports: true, onlyReasoning: true, supportedEfforts: ['low'], defaultEffort: 'low', canDisableThinking: false },
  }])
  return catalog
}

interface Harness {
  service: WorkBuddyProbeService
  store: WorkBuddyProbeStore
  account: { current: string | undefined }
  consent: { allowed: boolean }
  calls: (string | undefined)[]
}

function harness(send: ProbeSender, account = 'uid-1:', consent = true, catalog?: WorkBuddyCatalog): Harness {
  if (root === undefined) throw new Error('no root')
  const store = new WorkBuddyProbeStore({ path: join(root, '.workbuddy-probe.json'), pluginVersion: '0.0.0-test' })
  const holder = { current: account as string | undefined }
  const gate = { allowed: consent }
  const calls: (string | undefined)[] = []
  const service = new WorkBuddyProbeService({
    store,
    catalog: catalog ?? undeclaredCatalog(),
    credentials: { current: async () => ({ ...CREDENTIAL }) } as never,
    client: {} as never,
    consent: () => gate.allowed,
    account: () => holder.current,
    send: () => async (effort, signal) => {
      calls.push(effort)
      return send(effort, signal)
    },
  })
  return { service, store, account: holder, consent: gate, calls }
}

const ACCEPT = { status: 200, streamed: true }
const REJECT = { status: 400, streamed: false, errorCode: 'invalid_reasoning_effort' }

describe('WorkBuddyProbeService', () => {
  it('refuses without consent unless the call is manual', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const h = harness(async () => ACCEPT, 'uid-1:', false)
    expect(await h.service.probe('probe-me')).toEqual({ state: 'unavailable', reason: 'probing is not authorized' })
    expect(h.calls).toEqual([])
  })

  it('rejects unknown models and models that need no detection', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const h = harness(async () => ACCEPT)
    expect((await h.service.probe('nope', true)).state).toBe('unavailable')
    // Declared-set models are never probed: same harness, declared catalog.
    const h2 = harness(async () => ACCEPT, 'uid-1:', true, declaredCatalog())
    expect(await h2.service.probe('probe-me', true)).toEqual({ state: 'unavailable', reason: 'model does not need detection' })
  })

  it('runs a full validating sweep and reuses the record without new requests', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const answers: Record<string, { status: number; streamed: boolean; errorCode?: string }> = {
      low: ACCEPT, medium: REJECT,
    }
    const h = harness(async effort => effort === undefined ? ACCEPT : (answers[effort!] ?? REJECT))
    const first = await h.service.probe('probe-me', true)
    expect(first.state).toBe('ok')
    if (first.state === 'ok') {
      expect(first.validation).toBe('validating')
      expect(first.efforts).toEqual(['low'])
    }
    const sent = h.calls.length
    expect(sent).toBeGreaterThan(0)
    // Non-manual callers reuse the decisive record: zero new requests.
    // A fresh service over the same store file sees the stored observation.
    const reread = new WorkBuddyProbeService({
      store: h.store, catalog: undeclaredCatalog(),
      credentials: { current: async () => ({ ...CREDENTIAL }) } as never,
      client: {} as never, consent: () => true, account: () => 'uid-1:',
      send: () => async () => { throw new Error('must not send') },
    })
    const second = await reread.probe('probe-me')
    expect(second).toEqual({ state: 'ok', validation: 'validating', efforts: ['low'], requests: 0 })
  })

  it('drops an observation when the account changes mid-flight', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const holder = { current: 'uid-1:' as string | undefined }
    const store = new WorkBuddyProbeStore({ path: join(root, '.workbuddy-probe.json'), pluginVersion: '0.0.0-test' })
    const service = new WorkBuddyProbeService({
      store,
      catalog: undeclaredCatalog(),
      credentials: { current: async () => ({ ...CREDENTIAL }) } as never,
      client: {} as never,
      consent: () => true,
      account: () => holder.current,
      send: () => async effort => {
        // Flip on the first non-baseline attempt (the sentinel): the sweep
        // then runs to completion under the new account and must be dropped.
        if (effort !== undefined) holder.current = 'uid-2:'
        return ACCEPT
      },
    })
    const result = await service.probe('probe-me', true)
    expect(result).toEqual({ state: 'unavailable', reason: 'account changed during detection' })
    // Nothing stored under either account.
    expect(store.get('probe-me', 'x', 'uid-1:')).toBeUndefined()
    expect(store.get('probe-me', 'x', 'uid-2:')).toBeUndefined()
  })

  it('auto-detects missing candidates only when authorized', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    // 未授权：自动检测是空操作，零请求。
    const gated = harness(async () => ACCEPT, 'uid-1:', false)
    gated.service.probeMissingCandidates()
    expect(gated.calls).toEqual([])

    // 已授权：候选（未声明档位且无有效记录）自动入队并落盘。
    const h = harness(async effort => effort === undefined ? ACCEPT : (effort === 'low' ? ACCEPT : REJECT))
    h.service.probeMissingCandidates()
    // isRunning 在队列入队前为 false，不能当完成信号——直接等请求发出、
    // 再等记录落盘（单候选时队列即空）。
    await vi.waitFor(() => expect(h.calls.length).toBeGreaterThan(0))
    await vi.waitFor(() =>
      expect(h.store.get('probe-me', fingerprintModel(undeclaredCatalog().current()[0]!), 'uid-1:')?.validation).toBe('validating'))
  })

  it('skips candidates that already have a usable observation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-psvc-'))
    const h = harness(async effort => effort === undefined ? ACCEPT : (effort === 'low' ? ACCEPT : REJECT))
    const first = await h.service.probe('probe-me', true)
    expect(first.state).toBe('ok')
    const sent = h.calls.length
    expect(sent).toBeGreaterThan(0)
    // 再次自动检测：记录仍有效（同指纹、同账号、未过期），零新请求。
    h.service.probeMissingCandidates()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.calls.length).toBe(sent)
  })
})
