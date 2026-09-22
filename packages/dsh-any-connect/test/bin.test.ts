import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/bin.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('dsh-any-connect CLI --provider', () => {
  it('rejects an unknown provider naming the valid ids', async () => {
    const err: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--provider', 'nope'])).toBe(1)
      expect(err.join('')).toContain('workbuddy-ai')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports the AI variant signed out against an empty home', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AI_AUTH_FILE', join(root, 'no-such-ai-file.info'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'no-such-file.info'))
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status', '--provider=workbuddy-ai'])).toBe(1)
      expect(out.join('')).toContain('signed out')
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps the default provider CN when --provider is absent', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-bin-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'no-such-file.info'))
    const out: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk))
      return true
    })
    try {
      expect(await run(['status'])).toBe(1)
      expect(out.join('')).toContain('WorkBuddy Connect: signed out')
    } finally {
      spy.mockRestore()
    }
  })
})
