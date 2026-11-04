import { describe, expect, it } from 'vitest'
import { classifyUpstreamError } from '../src/upstream-shared.js'

/**
 * 上游失败分类回归。
 *
 * 关键点：**HTTP 状态码不是语义**。智谱把欠费、套餐到期、无模型权限、风控封禁
 * 和真限流全塞进 HTTP 429（官方错误码表），而只有「限流」值得重试。按状态码
 * 一刀切会让不可重试的失败被无限重试，用户永远等不到成功。
 */

describe('classifyUpstreamError：智谱 429 里的多种语义', () => {
  it('1302 触发用户速率限制 = 真限流，可重试', () => {
    expect(classifyUpstreamError(429, '{"error":{"code":1302,"message":"您的账户已达到速率限制"}}')).toBe('soft_rate')
  })

  it('1305 平台服务过载 = 真限流，可重试', () => {
    expect(classifyUpstreamError(429, '{"error":{"code":1305,"message":"该模型当前访问量过大"}}')).toBe('soft_rate')
  })

  it('1113 账户已欠费 = 不可重试（重试永远不会成功）', () => {
    expect(classifyUpstreamError(429, '{"error":{"code":1113,"message":"您的账户已欠费"}}')).toBe('hard_credit')
  })

  it('1309 套餐已到期 = 不可重试', () => {
    expect(classifyUpstreamError(429, '{"error":{"code":1309,"message":"套餐已到期"}}')).toBe('hard_credit')
  })

  it('1311 套餐未开通该模型 = 换模型而非重试', () => {
    expect(classifyUpstreamError(429, '{"error":{"code":1311,"message":"当前套餐未开通该模型"}}')).toBe('auth_forbidden')
  })

  it('1313 账号被风控封禁 = 申诉而非重试', () => {
    expect(classifyUpstreamError(429, '{"error":{"code":1313,"message":"账号已被封禁"}}')).toBe('auth_forbidden')
  })

  it('带空格的 code 形态同样识别（上游序列化不统一）', () => {
    expect(classifyUpstreamError(429, '{"error": {"code": 1113}}')).toBe('hard_credit')
  })

  it('未知错误码的 429 仍按限流处理（默认可重试是更安全的姿态）', () => {
    expect(classifyUpstreamError(429, '{"error":{"code":9999,"message":"something"}}')).toBe('soft_rate')
  })

  it('错误码只在 429 分支生效：非 429 的 1113 不改变原分类', () => {
    // 400 走 client，不该因为正文里出现错误码就被当成欠费。
    expect(classifyUpstreamError(400, '{"error":{"code":1113}}')).toBe('client')
  })
})

describe('classifyUpstreamError：既有口径不回退', () => {
  it('402 余额耗尽 = hard_credit', () => {
    expect(classifyUpstreamError(402, 'insufficient balance')).toBe('hard_credit')
  })

  it('OpenCode FreeTierError 的 403 归为限流而非授权失败', () => {
    expect(classifyUpstreamError(403, 'FreeTierError: free tier limited')).toBe('soft_rate')
  })

  it('OpenCode FreeUsageLimitError 的 429 归为限流（额度会重置，不是欠费）', () => {
    const body = '{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached."}}'
    expect(classifyUpstreamError(429, body)).toBe('soft_rate')
  })

  it('普通 403 仍是授权拒绝', () => {
    expect(classifyUpstreamError(403, '{"code":11140}')).toBe('auth_forbidden')
  })

  it('5xx 归为服务端故障', () => {
    expect(classifyUpstreamError(503, 'busy')).toBe('server')
  })
})
