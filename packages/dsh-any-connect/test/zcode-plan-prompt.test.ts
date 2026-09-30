import { describe, expect, it } from 'vitest'
import {
  hasStartPlanPrefix,
  prepareStartPlanBody,
  withStartPlanPrefix,
  ZCODE_CLIENT_IDENTITY,
  ZCODE_CLIENT_PREFIX,
  ZCODE_CLIENT_PREFIX_LENGTH,
} from '../src/index.js'

/**
 * The dedicated Start Plan channel admits a request only when its `system`
 * opens with the official client prompt; anything else answers 405 `code 3012`.
 * These cases pin the contract measured against the live endpoint on
 * 2026-09-30 (boundary binary-searched: 1210 rejected, 1211 accepted), so a
 * future edit that trims "unused" prefix characters fails here rather than in
 * production.
 */
describe('Start Plan 请求体指纹', () => {
  it('指纹常量与实测边界一致', () => {
    expect(ZCODE_CLIENT_IDENTITY).toBe('You are ZCode, an interactive coding agent')
    expect(ZCODE_CLIENT_PREFIX_LENGTH).toBe(ZCODE_CLIENT_PREFIX.length)
    expect(ZCODE_CLIENT_PREFIX_LENGTH).toBe(1211)
    // 官方提示词以换行开头且以可点击路径那句结尾——截断点落在句中。
    expect(ZCODE_CLIENT_PREFIX.startsWith('\nYou are an interactive ZCode agent')).toBe(true)
    expect(ZCODE_CLIENT_PREFIX.endsWith('— it\'s clickable.')).toBe(true)
  })

  it('字符串 system 变成"指纹 + 自己那块"', () => {
    const out = withStartPlanPrefix('You are DSH.') as Array<{ type: string; text: string }>
    expect(out.map(block => block.text)).toEqual([ZCODE_CLIENT_IDENTITY, ZCODE_CLIENT_PREFIX, 'You are DSH.'])
    expect(out.every(block => block.type === 'text')).toBe(true)
  })

  it('数组 system 的块序保留在指纹之后（Harness 提示词不被顶掉）', () => {
    const own = [{ type: 'text', text: 'block A' }, { type: 'text', text: 'block B' }]
    const out = withStartPlanPrefix(own) as Array<{ text: string }>
    expect(out.map(block => block.text)).toEqual([ZCODE_CLIENT_IDENTITY, ZCODE_CLIENT_PREFIX, 'block A', 'block B'])
  })

  it('缺 system 时只发指纹', () => {
    expect(withStartPlanPrefix(undefined)).toEqual([
      { type: 'text', text: ZCODE_CLIENT_IDENTITY },
      { type: 'text', text: ZCODE_CLIENT_PREFIX },
    ])
    expect(withStartPlanPrefix(null)).toHaveLength(2)
  })

  it('空字符串 system 不产生多余空块', () => {
    expect(withStartPlanPrefix('')).toHaveLength(2)
  })

  it('已带指纹的值原样返回（重试/重放不叠加）', () => {
    const already = [{ type: 'text', text: ZCODE_CLIENT_IDENTITY }, { type: 'text', text: ZCODE_CLIENT_PREFIX }]
    expect(hasStartPlanPrefix(already)).toBe(true)
    expect(withStartPlanPrefix(already)).toBe(already)
    // 前缀之外还有自己的内容同样算"已带指纹"。
    expect(hasStartPlanPrefix([...already, { type: 'text', text: 'own' }])).toBe(true)
  })

  it('指纹块不足、次序不对、或被改写时都不算已带指纹', () => {
    expect(hasStartPlanPrefix(undefined)).toBe(false)
    expect(hasStartPlanPrefix('You are ZCode, an interactive coding agent')).toBe(false)
    expect(hasStartPlanPrefix([{ type: 'text', text: ZCODE_CLIENT_IDENTITY }])).toBe(false)
    expect(hasStartPlanPrefix([
      { type: 'text', text: 'own first' },
      { type: 'text', text: ZCODE_CLIENT_PREFIX },
    ])).toBe(false)
    // 只覆盖前缀里的一小部分不算（实测 1210 字符仍被 3012 拦）。
    expect(hasStartPlanPrefix([
      { type: 'text', text: ZCODE_CLIENT_IDENTITY },
      { type: 'text', text: ZCODE_CLIENT_PREFIX.slice(0, 1210) },
    ])).toBe(false)
  })

  it('非文本块的畸形 system 原样放行，交给上游报真实错误', () => {
    const weird = { role: 'system', content: 'x' }
    expect(withStartPlanPrefix(weird)).toBe(weird)
  })

  it('prepareStartPlanBody 改写已准备好的请求体', () => {
    const body = prepareStartPlanBody(JSON.stringify({
      model: 'glm-5.3-flash',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }))
    const parsed = JSON.parse(body) as { system: Array<{ text: string }>; messages: unknown[] }
    expect(parsed.system.map(block => block.text)).toEqual([ZCODE_CLIENT_IDENTITY, ZCODE_CLIENT_PREFIX])
    // 其余字段一字不动。
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('prepareStartPlanBody 对非对象/非 JSON 输入原样返回', () => {
    expect(prepareStartPlanBody('not json')).toBe('not json')
    expect(prepareStartPlanBody('[]')).toBe('[]')
    expect(prepareStartPlanBody('"str"')).toBe('"str"')
  })

  it('幂等：连续改写两次结果相同', () => {
    const once = prepareStartPlanBody(JSON.stringify({ messages: [], system: 'own' }))
    expect(prepareStartPlanBody(once)).toBe(once)
  })
})
