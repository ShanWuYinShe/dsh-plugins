import { describe, expect, it } from 'vitest'
import {
  PROBE_EFFORT_CANDIDATES,
  probeModel,
  type ProbeAttempt,
  type ProbeSender,
} from '../src/probe.js'

const ACCEPT: ProbeAttempt = { status: 200, streamed: true }
const REJECT: ProbeAttempt = { status: 400, streamed: false, errorCode: 'invalid_reasoning_effort' }

/** Scripted sender: maps effort (undefined = baseline) to a canned answer. */
function scripted(answers: Record<string, ProbeAttempt>, log: (string | undefined)[]): ProbeSender {
  return async (effort: string | undefined) => {
    log.push(effort)
    if (effort === undefined) return answers['baseline'] ?? ACCEPT
    return answers[effort] ?? REJECT
  }
}

describe('probeModel', () => {
  it('reports unknown when the baseline itself does not stream', async () => {
    const log: (string | undefined)[] = []
    const outcome = await probeModel({
      send: scripted({ baseline: { status: 500, streamed: false } }, log),
      sentinel: () => 'probe_sentinel_x',
      candidates: ['low'],
      timeoutMs: 1000,
    })
    expect(outcome.validation).toBe('unknown')
    expect(outcome.requests).toBe(1)
    expect(log).toEqual([undefined])
  })

  it('reports non-validating when the sentinel is accepted, spending nothing more', async () => {
    const log: (string | undefined)[] = []
    const outcome = await probeModel({
      send: scripted({ sentinel: ACCEPT }, log),
      sentinel: () => 'sentinel',
      candidates: ['low', 'high'],
      timeoutMs: 1000,
    })
    expect(outcome).toEqual({ validation: 'non-validating', efforts: [], requests: 2 })
    // Sentinel accepted: per-level answers would be false positives, stop.
    expect(log).toEqual([undefined, 'sentinel'])
  })

  it('reports unknown when the sentinel answer is indecisive', async () => {
    const outcome = await probeModel({
      send: scripted({ sentinel: { status: 500, streamed: false } }, []),
      sentinel: () => 'sentinel',
      candidates: ['low'],
      timeoutMs: 1000,
    })
    expect(outcome.validation).toBe('unknown')
    if (outcome.validation === 'unknown') expect(outcome.reason).toContain('sentinel')
  })

  it('collects exactly the accepted levels after a refused sentinel', async () => {
    const log: (string | undefined)[] = []
    const outcome = await probeModel({
      send: scripted({ low: ACCEPT, high: REJECT }, log),
      sentinel: () => 'sentinel',
      candidates: ['low', 'high', 'max'],
      timeoutMs: 1000,
    })
    expect(outcome).toEqual({ validation: 'validating', efforts: ['low'], requests: 5 })
    expect(log).toEqual([undefined, 'sentinel', 'low', 'high', 'max'])
  })

  it('reports unknown rather than a partial list on a mid-sweep surprise', async () => {
    const outcome = await probeModel({
      send: scripted({ low: ACCEPT, high: { status: 429, streamed: false } }, []),
      sentinel: () => 'sentinel',
      candidates: ['low', 'high'],
      timeoutMs: 1000,
    })
    expect(outcome.validation).toBe('unknown')
    if (outcome.validation === 'unknown') {
      expect(outcome.efforts).toEqual([])
      expect(outcome.reason).toContain('level high')
    }
  })

  it('counts a sender throw as a transport failure', async () => {
    const outcome = await probeModel({
      send: async () => { throw new Error('socket hang up') },
      sentinel: () => 'sentinel',
      candidates: ['low'],
      timeoutMs: 1000,
    })
    expect(outcome.validation).toBe('unknown')
    if (outcome.validation === 'unknown') expect(outcome.reason).toContain('transport error')
  })

  it('tests the canonical five levels by default', () => {
    expect(PROBE_EFFORT_CANDIDATES).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})
