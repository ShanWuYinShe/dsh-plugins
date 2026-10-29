import { describe, expect, it, vi } from 'vitest'
import { resolveConfigPersist } from '../src/config-store.js'

/**
 * 官方 configEditor 持久化适配的直接测试。
 *
 * 本文件与 session-archive/src/config-store.ts **逐字一致**（由 bundle 锁钉住），
 * 所以这里钉住的行为对两份都生效——两侧不可能漂移。
 *
 * 覆盖：官方 configEditor 通道解析（resolveConfigPersist 的可用与降级）。
 * 旧版 config.json 迁移已随 0.2.2 适配删除（配置只走官方通道）。
 * 持久化本体（profile patch 的原子写与对账）由官方 dsh-config-editor 负责，
 * 不在本文件测试面内。
 */

describe('resolveConfigPersist', () => {
  function makeCtx({ entry, editor, getThrows }: { entry?: unknown; editor?: unknown; getThrows?: boolean }) {
    return {
      fiber: entry === undefined ? undefined : { entry },
      get: (name: string) => {
        if (getThrows) throw new Error('service missing')
        if (name === 'configEditor') return editor
        return undefined
      },
    }
  }

  it('entry 与 config-editor 都在时，edit 透传给 editor.edit(entry, change)', async () => {
    const entry = { options: { id: 'test' } }
    const edit = vi.fn(async (_e: unknown, _change: unknown) => {})
    const persist = resolveConfigPersist(makeCtx({ entry, editor: { edit } }))
    expect(persist).toBeDefined()
    const change = () => ({ a: 1 })
    await persist!.edit(change)
    expect(edit).toHaveBeenCalledWith(entry, change)
  })

  it('无 fiber entry（非 profile 部署）返回 undefined', () => {
    expect(resolveConfigPersist(makeCtx({}))).toBeUndefined()
  })

  it('config-editor 服务缺失返回 undefined', () => {
    const entry = { options: { id: 'test' } }
    expect(resolveConfigPersist(makeCtx({ entry, editor: undefined }))).toBeUndefined()
  })

  it('ctx.get 抛错（宿主服务解析失败）返回 undefined 而非外泄异常', () => {
    const entry = { options: { id: 'test' } }
    expect(resolveConfigPersist(makeCtx({ entry, getThrows: true }))).toBeUndefined()
  })

  it('editor.edit 的拒绝原样向上传播（由调用方决定失败姿态）', async () => {
    const entry = { options: { id: 'test' } }
    const edit = vi.fn(async () => { throw new Error('reconciliation failed') })
    const persist = resolveConfigPersist(makeCtx({ entry, editor: { edit } }))!
    await expect(persist.edit(() => ({}))).rejects.toThrow('reconciliation failed')
  })
})
