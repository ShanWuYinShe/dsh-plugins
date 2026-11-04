import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { SessionArchiveGateway } from '../src/remote.js'

/**
 * Host 入口 apply 接线回归（SA-18）：
 * - 生效配置经 normalizeConfig 归一化后传给 Gateway 的 host 组合对象；
 * - 非法配置（绕过 Loader schema 直调 apply）必须经宿主 logger.warn 告警
 *   后回退默认值，不再静默。
 */
function makeCtx() {
  const plugins: Array<{ plugin: unknown; config: any }> = []
  const warnings: string[] = []
  const ctx: any = {
    // createArchiveHost 只消费这三个宿主服务 + 可选 sessionQuery 的 get 探测。
    workspaceRegistry: { archivedSessionIds: [], unarchiveSession: async () => {} },
    sessionPersistence: {},
    sessions: { get: () => undefined },
    get: () => undefined,
    logger: { warn: (message: string) => warnings.push(message) },
    plugin: (plugin: unknown, config: any) => plugins.push({ plugin, config }),
  }
  return { ctx, plugins, warnings }
}

describe('apply 接线', () => {
  it('注册 Gateway，并把归一化后的配置喂给 host 组合对象', () => {
    const { ctx, plugins, warnings } = makeCtx()
    apply(ctx, { detailMaxMessages: 7 })
    expect(plugins).toHaveLength(1)
    expect(plugins[0]!.plugin).toBe(SessionArchiveGateway)
    expect(plugins[0]!.config.host).toBeDefined()
    // 合法值不告警。
    expect(warnings).toEqual([])
  })

  it('非法配置经 logger.warn 告警并回退默认值（最终防线不静默）', () => {
    const { ctx, plugins, warnings } = makeCtx()
    apply(ctx, { detailMaxMessages: -5 })
    expect(plugins).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('detailMaxMessages')
    expect(warnings[0]).toContain('-5')
  })

  it('logger 缺失时 apply 不抛错（可选诊断通道）', () => {
    const { ctx } = makeCtx()
    delete ctx.logger
    expect(() => apply(ctx, { detailMaxMessages: -5 })).not.toThrow()
  })
})
