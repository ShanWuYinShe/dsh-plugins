import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BUILTIN_USAGE_QUERIERS, apply } from '../src/index.js'

/**
 * 入口挂载回归：apply 在只有空 Context（无 webServer、无 llm 等可选服务）
 * 时不得抛错——缺服务是部署常态，fail-safe 姿态要求静默等待而非启动失败。
 * 内置注册表 9 路由的键集合由 providers.test.ts 锁定，这里只锁数量一致。
 */

describe('apply', () => {
  it('空 Context 下不抛错', () => {
    expect(() => apply(new Context())).not.toThrow()
  })

  it('内置注册表覆盖 9 个路由', () => {
    expect(BUILTIN_USAGE_QUERIERS.size).toBe(9)
  })
})
