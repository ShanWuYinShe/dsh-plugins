/**
 * credit-ledger.test.ts — WorkBuddy 积分消耗台账的纯逻辑与服务回归。
 *
 * 覆盖（见 src/credit-ledger.ts 的口径注释）：
 * 1. applyObservation 差分记账：消耗/发放/峰值、跨天首观测不计差分、31 天裁剪；
 * 2. summarize：今日 + 最近 7 天历史、今日无样本返回 undefined；
 * 3. CreditLedger 服务：按变体串行、record 从不 reject（持久化故障吞掉）、
 *    summary 等待写链排空；
 * 4. standalone 只读：空台账安静返回 undefined（写侧只有宿主域，不经单测，
 *    与 state-store.test.ts 的域处理一致）。
 *
 * @module dsh-any-connect/credit-ledger-test
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyObservation,
  CreditLedger,
  dateKeyOf,
  summarize,
} from '../src/credit-ledger.js'
import type { CreditLedgerDay, CreditLedgerPersistence, CreditLedgerState } from '../src/credit-ledger.js'
import { openStandaloneStateStore } from '../src/state-store.js'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** 固定「今天」：2026-10-26 12:00 本地时（dateKeyOf 用本地日历日，构造也用本地）。 */
function at(day: number, hour = 12, minute = 0): Date {
  return new Date(2026, 9, day, hour, minute, 0)
}

function day(overrides: Partial<CreditLedgerDay> & { date: string }): CreditLedgerDay {
  return {
    peak: 0,
    last: 0,
    consumed: 0,
    granted: 0,
    samples: 1,
    updatedAtMs: 0,
    ...overrides,
  }
}

describe('dateKeyOf', () => {
  it('uses the local calendar day, zero-padded', () => {
    expect(dateKeyOf(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02')
    expect(dateKeyOf(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31')
  })
})

describe('applyObservation', () => {
  it('第一条观测只立基准，不计差分（跨夜窗口无法归属）', () => {
    const days = applyObservation([], 693, at(26))
    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ date: '2026-10-26', peak: 693, last: 693, consumed: 0, granted: 0, samples: 1 })
  })

  it('负差分计消耗，正差分计发放，峰值取最大', () => {
    let days = applyObservation([], 800, at(26, 9))
    days = applyObservation(days, 755, at(26, 10)) // 消耗 45
    days = applyObservation(days, 755, at(26, 11)) // 不变
    days = applyObservation(days, 855, at(26, 20)) // 发放 +100（裂变包）
    days = applyObservation(days, 850, at(26, 21)) // 再消耗 5
    expect(days[0]).toMatchObject({ consumed: 50, granted: 100, peak: 855, last: 850, samples: 5 })
  })

  it('跨天开新天：首观测立新基准不继承昨尾差分，旧天保留', () => {
    let days = applyObservation([], 1000, at(25, 22))
    days = applyObservation(days, 950, at(26, 8))
    expect(days).toHaveLength(2)
    expect(days[1]).toMatchObject({ date: '2026-10-26', peak: 950, last: 950, consumed: 0, granted: 0 })
    expect(days[0]).toMatchObject({ date: '2026-10-25', last: 1000 })
    // 当天后续照常差分。
    days = applyObservation(days, 900, at(26, 9))
    expect(days[1]).toMatchObject({ consumed: 50 })
  })

  it('乱序输入按日期排序后记账，裁剪到最近 31 天', () => {
    const september = Array.from({ length: 30 }, (_, i): CreditLedgerDay =>
      day({ date: '2026-09-' + (i + 1).toString().padStart(2, '0') }))
    const october = Array.from({ length: 10 }, (_, i): CreditLedgerDay =>
      day({ date: '2026-10-' + (i + 1).toString().padStart(2, '0') }))
    // 40 个旧天 + 今天共 41 条，裁剪后只剩 31 天且今天在内（丢掉最老的 09-01..09-10）。
    const days = applyObservation([...september, ...october], 500, at(26))
    expect(days).toHaveLength(31)
    expect(days[days.length - 1]).toMatchObject({ date: '2026-10-26', peak: 500 })
    expect(days[0]!.date).toBe('2026-09-11')
  })

  it('不修改输入数组（纯函数）', () => {
    const original = [day({ date: '2026-10-26', peak: 10, last: 10 })]
    const frozen = [...original]
    applyObservation(original, 5, at(26))
    expect(original).toEqual(frozen)
  })
})

describe('summarize', () => {
  it('今日无样本返回 undefined', () => {
    expect(summarize([day({ date: '2026-10-25' })], at(26))).toBeUndefined()
    expect(summarize([], at(26))).toBeUndefined()
  })

  it('返回今日与最近 7 天历史（正序、不含今天）', () => {
    const days = [
      day({ date: '2026-10-17', consumed: 1 }),
      day({ date: '2026-10-18', consumed: 2 }),
      day({ date: '2026-10-26', consumed: 45, peak: 793 }),
      day({ date: '2026-10-19', consumed: 3 }),
      day({ date: '2026-10-20', consumed: 4 }),
      day({ date: '2026-10-21', consumed: 5 }),
      day({ date: '2026-10-22', consumed: 6 }),
      day({ date: '2026-10-23', consumed: 7 }),
      day({ date: '2026-10-24', consumed: 8 }),
      day({ date: '2026-10-25', consumed: 9 }),
    ]
    const summary = summarize(days, at(26))
    expect(summary?.today).toMatchObject({ date: '2026-10-26' })
    expect(summary?.history.map(d => d.date)).toEqual([
      '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25',
    ])
  })
})

describe('CreditLedger 服务', () => {
  function memoryPersistence(): CreditLedgerPersistence & { states: Map<string, CreditLedgerState> } {
    const states = new Map<string, CreditLedgerState>()
    return {
      states,
      load: async variantId => states.get(variantId),
      save: async (variantId, state) => {
        states.set(variantId, state)
      },
    }
  }

  it('按变体分键记账，summary 读到刚记的样本', async () => {
    const persistence = memoryPersistence()
    const ledger = new CreditLedger(persistence)
    await ledger.record('workbuddy', 800, at(26, 9))
    await ledger.record('workbuddy', 700, at(26, 10))
    await ledger.record('workbuddy-ai', 50, at(26, 10))
    const summary = await ledger.summary('workbuddy', at(26))
    expect(summary?.today).toMatchObject({ consumed: 100, peak: 800 })
    expect((await ledger.summary('workbuddy-ai', at(26)))?.today).toMatchObject({ peak: 50 })
  })

  it('record 从不 reject：持久化故障吞掉并继续工作', async () => {
    const failing: CreditLedgerPersistence = {
      load: async () => {
        throw new Error('disk gone')
      },
      save: async () => {
        throw new Error('disk gone')
      },
    }
    const ledger = new CreditLedger(failing)
    await expect(ledger.record('workbuddy', 1)).resolves.toBe(false)
    await expect(ledger.record('workbuddy', 2)).resolves.toBe(false)
  })

  it('并发的 record 不互相覆盖（per-variant 串行链）', async () => {
    const persistence = memoryPersistence()
    const ledger = new CreditLedger(persistence)
    await Promise.all([
      ledger.record('workbuddy', 100, at(26, 9, 0)),
      ledger.record('workbuddy', 90, at(26, 9, 1)),
      ledger.record('workbuddy', 80, at(26, 9, 2)),
    ])
    const state = persistence.states.get('workbuddy')
    expect(state?.days[0]).toMatchObject({ consumed: 20, peak: 100, samples: 3 })
  })

  it('summary 等待写链排空（record 后立刻 summary 也含新样本）', async () => {
    const persistence = memoryPersistence()
    const ledger = new CreditLedger(persistence)
    const [, summary] = await Promise.all([
      ledger.record('workbuddy', 500, at(26)),
      ledger.summary('workbuddy', at(26)),
    ])
    expect(summary?.today).toMatchObject({ peak: 500 })
  })
})

describe('openStandaloneStateStore().readLedger', () => {
  it('空台账安静返回 undefined（损坏/缺席记录不炸诊断）', async () => {
    root = await mkdtemp(join(tmpdir(), 'wb-ledger-'))
    vi.stubEnv('DSH_HOME', root)
    const store = await openStandaloneStateStore()
    try {
      expect(await store.readLedger('workbuddy')).toBeUndefined()
    } finally {
      await store.close()
    }
  })
})
