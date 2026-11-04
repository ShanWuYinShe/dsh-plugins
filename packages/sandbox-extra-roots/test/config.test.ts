/**
 * Config schema 回归（RULE-060）：入口导出的 Config 必须补齐默认值、拒绝
 * 形状非法值，并与 apply 的默认配置同形。
 *
 * 平台无关：不触碰真实文件系统，只调用 schema。
 */

import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { DEFAULT_CONFIG } from '../src/plugin-config.js'

/** 负向用例故意传非法形状：把 schema 收成宽签名，避免把测试意图压成类型错误。 */
const parseLoose = Config as unknown as (input: Record<string, unknown>) => Record<string, unknown>

describe('Config schema', () => {
  it('空对象补齐默认值，且与 DEFAULT_CONFIG / cordis.patch.yml 同形', () => {
    expect(Config({})).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG).toEqual({ extraWritableRoots: [] })
  })

  it('接受绝对路径字符串数组并原样保留', () => {
    expect(Config({ extraWritableRoots: ['/tmp/a', '~/cache'] })).toEqual({
      extraWritableRoots: ['/tmp/a', '~/cache'],
    })
  })

  it('拒绝非数组/非字符串元素（fail loud，不静默忽略）', () => {
    expect(() => parseLoose({ extraWritableRoots: '/tmp/a' })).toThrow(/extraWritableRoots/)
    expect(() => parseLoose({ extraWritableRoots: [42] })).toThrow(/extraWritableRoots/)
  })

  it('未知字段由 schema 保留（rc.1 schemastery 实测策略），治理交给写入白名单/apply', () => {
    // 不依赖 schema 剥离未知字段：写入侧 remote.ts 只并入白名单字段，
    // 读取侧 normalizeRoots 只消费 extraWritableRoots（见 config.ts 注释）。
    expect(Config({ extraWritableRoots: [], futureField: 1 })).toEqual({
      extraWritableRoots: [],
      futureField: 1,
    })
  })
})
