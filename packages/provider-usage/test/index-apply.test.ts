import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as entry from '../src/index.js'
import { apply } from '../src/index.js'
import { BUILTIN_USAGE_QUERIERS } from '../src/providers.js'

/**
 * 入口挂载回归：apply 在只有空 Context（无 webServer、无 llm 等可选服务）
 * 时不得抛错——缺服务是部署常态，fail-safe 姿态要求静默等待而非启动失败。
 * 内置注册表 11 路由的键集合由 providers.test.ts 锁定，这里只锁数量一致。
 * 入口只导出 Loader 面（name/inject/apply），实现值走包内相对路径导入。
 */

describe('Loader 归一化后的入口面', () => {
  it('入口只导出四件：unwrapExports 原样返回（无 default / export *）', () => {
    // 官方判据：function plugin 若混入 default export，Loader 的
    // `unwrapExports`（exports.default ?? exports）会换掉整个插件命名空间，
    // 四件导出当场失效。这里用真实 Loader 归一化真实入口做一次守卫。
    const loader = new Loader(new Context())
    expect('default' in entry).toBe(false)
    expect(loader.unwrapExports(entry)).toBe(entry)
    expect(Object.keys(entry).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
  })
})

describe('apply', () => {
  it('空 Context 下不抛错', () => {
    expect(() => apply(new Context())).not.toThrow()
  })

  it('内置注册表覆盖 11 个路由', () => {
    expect(BUILTIN_USAGE_QUERIERS.size).toBe(11)
  })
})
