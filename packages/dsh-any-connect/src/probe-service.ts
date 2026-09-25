/**
 * Probe orchestration: the serial queue, and the bridge from an observation to
 * what the adapter may expose.
 *
 * Ported from corrinehu/dsh-workbuddy-connect `src/probe-service.ts` (MIT).
 * Kept separate from {@link module:dsh-any-connect/probe} so the protocol
 * stays a pure function of one model's responses, while queueing, persistence,
 * and policy live here. Detection runs automatically — every catalog refresh
 * sweeps the candidates that have no usable observation — under two structural
 * rules:
 *
 * - one probe at a time (a user's real chat must not contend with a sweep),
 * - each model is probed only when its catalog row changes (fingerprint) or
 *   the record expired, so the spend is bounded and one-off.
 *
 * @module dsh-any-connect/probe-service
 */

import type { WorkBuddyCredentialStore } from './auth.js'
import type { WorkBuddyCatalog } from './catalog.js'
import { fingerprintModel, type WorkBuddyProbeRecord, type WorkBuddyProbeStore } from './probe-store.js'
import { probeModel, type ProbeSender, type SentinelFactory } from './probe.js'
import type { WorkBuddyUpstreamClient } from './upstream.js'

/** What the caller learns about a completed probe. */
export type WorkBuddyProbeStatus =
  | { state: 'ok'; validation: WorkBuddyProbeRecord['validation']; efforts: readonly string[]; requests: number }
  | { state: 'unavailable'; reason: string }

/** Options for {@link WorkBuddyProbeService}. */
export interface WorkBuddyProbeServiceOptions {
  store: WorkBuddyProbeStore
  catalog: WorkBuddyCatalog
  credentials: WorkBuddyCredentialStore
  client: WorkBuddyUpstreamClient
  /**
   * The account currently in effect, as `uid:enterpriseId`, or `undefined`
   * while signed out.
   *
   * Records are read and written against this identity, and it is re-checked
   * after the sweep finishes: an observation produced under account A must not
   * be stored once account B is in effect, however long the probe took.
   */
  account: () => string | undefined
  sentinel?: SentinelFactory
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender
  /**
   * 自动清扫中的探针失败上报（清扫入口 probeMissingCandidates 丢弃
   * promise，rejection 若无人接就是 unhandled rejection，Node ≥15 默认
   * 策略下可终止宿主进程——credentials.current() 会因凭据区域不匹配
   * 抛 RegionMismatchError，非 ENOENT 文件错误也会 rethrow）。缺省丢弃，
   * host 层应接 logger.warn 让 RegionMismatch 这类可修复配置错误可见。
   */
  onSweepError?: (modelId: string, error: unknown) => void
}

/**
 * Serial probe runner. The automatic sweep is the only entry point, so a
 * sweep can never overlap itself or double-run a model.
 */
export class WorkBuddyProbeService {
  private readonly options: WorkBuddyProbeServiceOptions
  private queue: Promise<unknown> = Promise.resolve()
  private readonly pending = new Map<string, Promise<WorkBuddyProbeStatus>>()
  private running = false

  constructor(options: WorkBuddyProbeServiceOptions) {
    this.options = options
  }

  /** Whether a sweep is in flight right now. */
  isRunning(): boolean {
    return this.running
  }

  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * A declared set always wins, so a model that declares `supportedEfforts`
   * is never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyProbeRecord | undefined {
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return undefined
    if (info.reasoning?.supportedEfforts !== undefined && info.reasoning.supportedEfforts.length > 0) {
      return undefined
    }
    const account = this.options.account()
    // Signed out: there is no account to attribute an observation to, so none
    // is served (a previous account's record must not answer here).
    if (account === undefined) return undefined
    return this.options.store.get(modelId, fingerprintModel(info), account)
  }

  /**
   * Probe one model, serially.
   *
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  async probe(modelId: string): Promise<WorkBuddyProbeStatus> {
    const info = this.options.catalog.current().find(model => model.id === modelId)
    if (info === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
    const account = this.options.account()
    if (account === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }
    const pendingKey = JSON.stringify([account, modelId])
    const pending = this.pending.get(pendingKey)
    if (pending !== undefined) return pending

    const run = this.queue.then(async (): Promise<WorkBuddyProbeStatus> => {
      // Re-read inside the queue: an earlier sweep may have changed the catalog
      // or already answered this model.
      const current = this.options.catalog.current().find(model => model.id === modelId)
      if (current === undefined) return { state: 'unavailable', reason: `unknown model: ${modelId}` }
      if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) {
        return { state: 'unavailable', reason: 'model does not need detection' }
      }
      const cached = this.recordFor(modelId)
      if (cached !== undefined && cached.validation !== 'unknown') {
        return { state: 'ok', validation: cached.validation, efforts: cached.efforts, requests: 0 }
      }

      // The account this sweep is being run for. Captured before the requests
      // and re-checked before the write-back: a probe can outlive the account
      // it started under, and storing the result afterwards would resurrect
      // the previous account's answer.
      const activeAccount = this.options.account()
      if (activeAccount !== account) return { state: 'unavailable', reason: 'account changed before detection' }
      const credential = await this.options.credentials.current()
      if (credential === undefined) return { state: 'unavailable', reason: 'no WorkBuddy credential' }

      const send = this.options.send === undefined
        ? (effort: string | undefined, signal: AbortSignal) =>
            this.options.client.probeEffort(credential, modelId, effort, signal)
        : this.options.send(modelId)

      this.running = true
      try {
        const outcome = await probeModel({
          send,
          ...this.options.sentinel === undefined ? {} : { sentinel: this.options.sentinel },
        })
        // The account may have changed while the requests were in flight. Drop
        // the observation rather than attribute it to whoever is signed in now.
        if (this.options.account() !== account) {
          return { state: 'unavailable', reason: 'account changed during detection' }
        }
        const record = this.options.store.record(
          fingerprintModel(current),
          outcome.validation,
          outcome.efforts,
          account,
        )
        this.options.store.set(modelId, record)
        if (outcome.validation === 'unknown') {
          return { state: 'unavailable', reason: outcome.reason }
        }
        return { state: 'ok', validation: outcome.validation, efforts: record.efforts, requests: outcome.requests }
      } finally {
        this.running = false
      }
    })

    // Keep the chain alive regardless of this run's outcome, so one failure does
    // not poison every later probe.
    this.queue = run.catch(() => undefined)
    this.pending.set(pendingKey, run)
    try {
      return await run
    } finally {
      this.pending.delete(pendingKey)
    }
  }

  /**
   * Enqueue an automatic probe for every candidate the catalog serves that has
   * no usable observation yet. Each model goes through the same serial queue,
   * pending dedup, and account attribution, so a sweep can never overlap a
   * user's chat traffic or double-run a model.
   *
   * Called after every catalog refresh (startup, credential change, scheduled
   * refresh), which is when the candidate set can actually change. The catalog
   * fingerprint on each record makes re-probes automatic: a changed row
   * invalidates its old observation and the model becomes a candidate again.
   */
  probeMissingCandidates(): void {
    const candidates = this.options.catalog.current().filter(info =>
      info.reasoning?.supports === true
      && (info.reasoning.supportedEfforts?.length ?? 0) === 0)
    for (const info of candidates) {
      if (this.recordFor(info.id) === undefined) {
        // 显式 probe() 的调用方(路由)自带 catch;清扫是 fire-and-forget,
        // 必须 recv 住 rejection,否则 unhandled rejection 打崩宿主。
        void this.probe(info.id).catch((error: unknown) => {
          this.options.onSweepError?.(info.id, error)
        })
      }
    }
  }
}
