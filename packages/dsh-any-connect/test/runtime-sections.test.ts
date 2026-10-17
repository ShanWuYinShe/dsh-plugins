/**
 * 状态路由两个响应段的测试。
 *
 * 2026-10-08 补：这两段是「卡片上看到什么」的直接来源（探针结果、目录来源/时间/空/错误），
 * 此前只有整链路测试覆盖。它们是纯整形函数，喂一个只含被读字段的 runtime 即可断言。
 */

import { describe, expect, it } from 'vitest'
import { catalogSection, probeSection } from '../src/runtime-sections.js'
import type { VariantRuntime } from '../src/variant-runtime.js'

/** 只填被读到的字段：两个函数是纯整形，不需要完整宿主 runtime。 */
function runtimeWith(fields: Record<string, unknown>): VariantRuntime {
  return fields as unknown as VariantRuntime
}

describe('probeSection', () => {
  it('没有探针服务时返回空段（仅 WorkBuddy 变体带探针）', () => {
    expect(probeSection(runtimeWith({}))).toEqual({ running: false, results: [] })
  })

  it('有探针服务时最新在前，缺记录的模型跳过', () => {
    const runtime = runtimeWith({
      catalog: { current: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] },
      probeService: {
        isRunning: () => true,
        recordFor: (id: string) => {
          if (id === 'a') return { validation: 'ok', efforts: ['low'], probedAtMs: 100 }
          if (id === 'b') return { validation: 'fail', efforts: [], probedAtMs: 300 }
          return undefined
        },
      },
    })
    const section = probeSection(runtime)
    expect(section.running).toBe(true)
    expect(section.results.map((row) => row.id)).toEqual(['b', 'a'])
    expect(section.results[0]).toMatchObject({ name: 'B', validation: 'fail', probedAt: 300 })
  })
})

describe('catalogSection', () => {
  it('只有 source 时其余可选字段不出现', () => {
    expect(catalogSection(runtimeWith({ catalogSource: 'saved', catalogEmpty: false }))).toEqual({ source: 'saved' })
  })

  it('有拉取时间时带上 fetchedAt', () => {
    expect(catalogSection(runtimeWith({ catalogSource: 'live', catalogFetchedAtMs: 1234 })))
      .toEqual({ source: 'live', fetchedAt: 1234 })
  })

  it('empty 只在「拉到且为空、且无错误」时出现', () => {
    expect(catalogSection(runtimeWith({ catalogSource: 'live', catalogEmpty: true })))
      .toEqual({ source: 'live', empty: true })
  })

  it('有错误时不出现 empty（两者互斥：失败=保留旧名单，空=确实没有）', () => {
    const section = catalogSection(runtimeWith({ catalogSource: 'saved', catalogEmpty: true, catalogError: 'boom' }))
    expect(section).toEqual({ source: 'saved', error: 'boom' })
    expect('empty' in section).toBe(false)
  })
})
