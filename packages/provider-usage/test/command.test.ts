/** /usage 命令:格式化、handler 分支(全量/refresh/点名)与可选服务挂载。 */

import { describe, expect, it, vi } from 'vitest'
import { formatUsageLine, formatUsageReport, registerUsageCommand, usageCommand } from '../src/command.js'
import type { ProviderUsageRegistry } from '../src/registry.js'
import type { UsageSnapshot } from '../src/types.js'

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot & { displayName?: string } {
  return {
    provider: 'acme',
    windows: [{ id: 'w', label: 'W', remain: 3, unit: 'credits' }],
    fetchedAt: 7,
    ...overrides,
  }
}

/** 只实现 handler 消费的两个成员;provider-usage 包内极简 stub 的同款做法。 */
function makeRegistry(overrides: Partial<Pick<ProviderUsageRegistry, 'providers' | 'snapshot'>> = {}): ProviderUsageRegistry {
  return {
    providers: () => ['acme'],
    // 真实 registry.snapshot 会把注册期 displayName 回填进答案,stub 同形状。
    snapshot: vi.fn(async () => snapshot({ displayName: 'Acme' })),
    ...overrides,
  } as unknown as ProviderUsageRegistry
}

const invocation = (rawInput: string) => ({ rawInput, commandId: 'c1' as never, agent: {} as never, attachments: [], signal: new AbortController().signal })

describe('formatUsageLine', () => {
  it('偏好 displayName 并逐窗口拼接', () => {
    expect(formatUsageLine({ ...snapshot(), displayName: 'Acme' })).toBe('Acme: W 3 credits')
  })

  it('无 displayName 回 provider 键;多窗口逗号连接', () => {
    expect(formatUsageLine(snapshot({
      windows: [
        { id: 'a', label: 'CNY', remain: 42.5, unit: 'CNY' },
        { id: 'b', label: 'USD', remain: 1.2, unit: 'USD' },
      ],
    }))).toBe('acme: CNY 42.5 CNY, USD 1.2 USD')
  })

  it('error 快照与空窗口各有明确行', () => {
    expect(formatUsageLine(snapshot({ error: 'HTTP 502' }))).toBe('acme: error — HTTP 502')
    expect(formatUsageLine(snapshot({ windows: [] }))).toBe('acme: the provider reported no usable balance')
  })
})

describe('formatUsageReport', () => {
  it('按行拼接', () => {
    expect(formatUsageReport(['a', 'b'])).toBe('a\nb')
  })
})

describe('usageCommand handler', () => {
  it('空输入查全部 provider 并格式化', async () => {
    const registry = makeRegistry({ snapshot: vi.fn(async () => snapshot({ displayName: 'Acme' })) })
    const result = await usageCommand(registry).handler(invocation(''))
    expect(result).toEqual({ kind: 'success', text: 'Acme: W 3 credits' })
  })

  it('refresh 参数绕过缓存(force=true)', async () => {
    const snapshotFn = vi.fn(async () => snapshot())
    const registry = makeRegistry({ snapshot: snapshotFn })
    await usageCommand(registry).handler(invocation('refresh'))
    expect(snapshotFn).toHaveBeenCalledWith('acme', { force: true })
  })

  it('点名 provider 时规范化并单查', async () => {
    const snapshotFn = vi.fn(async () => snapshot({ displayName: 'Acme' }))
    const registry = makeRegistry({ snapshot: snapshotFn })
    const result = await usageCommand(registry).handler(invocation('  DeepSeek '))
    expect(snapshotFn).toHaveBeenCalledWith('deepseek', { force: false })
    expect((result as { text: string }).text).toBe('Acme: W 3 credits')
  })

  it('推断无果(undefined)输出不可查行', async () => {
    const registry = makeRegistry({ snapshot: vi.fn(async () => undefined) })
    const result = await usageCommand(registry).handler(invocation('ghost'))
    expect((result as { text: string }).text).toBe('ghost: (no querier resolved)')
  })

  it('error 快照进入报告文本', async () => {
    const registry = makeRegistry({ snapshot: vi.fn(async () => snapshot({ error: 'HTTP 502' })) })
    const result = await usageCommand(registry).handler(invocation(''))
    expect((result as { text: string }).text).toBe('acme: error — HTTP 502')
  })

  it('无注册 provider 时直接短路', async () => {
    const registry = makeRegistry({ providers: () => [] })
    const result = await usageCommand(registry).handler(invocation(''))
    expect(result).toEqual({ kind: 'success', text: 'no queryable provider is registered' })
  })
})

describe('registerUsageCommand', () => {
  it('经 inject(["commands"]) 注册并在 effect 返回反注册器', () => {
    const dispose = vi.fn()
    const register = vi.fn((_definition: unknown) => dispose)
    const effectDisposers: Array<() => void> = []
    const ctx = {
      inject(names: readonly string[], fn: (c: any) => void) {
        expect(names).toEqual(['commands'])
        fn({ commands: { register }, effect: (f: () => () => void) => { effectDisposers.push(f()) } })
      },
    }
    registerUsageCommand(ctx as never, makeRegistry())
    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]![0]).toMatchObject({ name: 'usage' })
    expect(effectDisposers).toHaveLength(1)
    effectDisposers[0]!()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
