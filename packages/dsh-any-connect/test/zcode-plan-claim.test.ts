import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPreviewHeaders,
  buildPreviewUrl,
  parseErrorCode,
  parsePreviewBody,
  previewStartPlan,
  upstreamCode,
  upstreamMessage,
  type StartPlanClaimCredential,
  type StartPlanPlatformInfo,
} from '../src/zcode-plan-claim.js'

/**
 * Start Plan 每日**预览**的能力边界回归。
 *
 * 核心结论（实测 2026-10-04，见模块头部）：claim 需要阿里云验证码，token 由
 * 客户端渲染进程签发、纯 Node 无法生成，因此全自动领取不可能，claim POST
 * 链已删除（无生产调用方）。测试钉死 preview 的分支分类：成功/空清单（今日
 * 已领取）/401 会话失效/网络失败必须各自如实报告，不互相伪装。
 */

const CREDENTIAL: StartPlanClaimCredential = { zcodeJwtToken: 'jwt-token', zcodeDeviceMid: 'mid-1' }
const INFO: StartPlanPlatformInfo = { appVersion: '3.4.0', platform: 'darwin-arm64' }

const PLAN_ID = 'zcode-v3-start-plan-trust-0930'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('请求构造（URL / 头 / body）', () => {
  it('preview URL 带 app_version 与 platform 两个查询参数', () => {
    expect(buildPreviewUrl(INFO)).toBe(
      'https://zcode.z.ai/api/v1/zcode-plan/billing/preview?app_version=3.4.0&platform=darwin-arm64',
    )
  })

  it('preview 头只用 Bearer JWT + 设备号，不带 captcha（探测不需要验证码）', () => {
    const headers = buildPreviewHeaders(CREDENTIAL)
    expect(headers['Authorization']).toBe('Bearer jwt-token')
    expect(headers['X-Device-Mid']).toBe('mid-1')
    expect(headers['X-Aliyun-Captcha-Verify-Param']).toBeUndefined()
  })
})

describe('响应解析纯函数', () => {
  it('code/msg 缺失时归一为 0 与空串', () => {
    expect(upstreamCode(undefined)).toBe(0)
    expect(upstreamCode({ data: {} })).toBe(0)
    expect(upstreamCode({ code: 3007 })).toBe(3007)
    expect(upstreamMessage({ msg: ' boom ' })).toBe('boom')
    expect(upstreamMessage({ message: 'fallback' })).toBe('fallback')
    expect(upstreamMessage('not-json')).toBe('')
  })

  it('非 JSON 错误体不抛错，返回 undefined', () => {
    expect(parseErrorCode('<html>502</html>')).toBeUndefined()
    expect(parseErrorCode('')).toBeUndefined()
    expect(parseErrorCode('{"code":3007}')).toBe(3007)
  })

  it('preview 空清单是合法结果（今日已领取），不是失败', () => {
    expect(parsePreviewBody({ code: 0, data: { plans: [] } })).toEqual([])
    expect(parsePreviewBody({ code: 0 })).toEqual([])
    expect(parsePreviewBody('nope')).toEqual([])
  })

  it('preview 解析 plan_id/name/priority/entitlements，并跳过缺 plan_id 的行', () => {
    const items = parsePreviewBody({
      code: 0,
      data: {
        plans: [
          { plan_id: 'a', name: 'ZCode Trust Build', priority: 1, entitlements: [{ grant_units: 100 }] },
          { name: '没有 plan_id 的行' },
          'not-an-object',
          { plan_id: '   ' },
        ],
      },
    })
    expect(items).toHaveLength(1)
    expect(items[0]?.planId).toBe('a')
    expect(items[0]?.name).toBe('ZCode Trust Build')
    expect(items[0]?.priority).toBe(1)
    expect(items[0]?.entitlements).toEqual([{ grant_units: 100 }])
  })

  it('preview 按 priority 降序稳定排序（缺 priority 的排最后）', () => {
    const items = parsePreviewBody({
      code: 0,
      data: { plans: [{ plan_id: 'low', priority: 1 }, { plan_id: 'none' }, { plan_id: 'high', priority: 9 }] },
    })
    expect(items.map(item => item.planId)).toEqual(['high', 'low', 'none'])
  })
})

describe('previewStartPlan（探测自动，无需 captcha）', () => {
  it('有待领取项时返回清单，且请求带 Bearer JWT 与设备号', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: { plans: [{ plan_id: PLAN_ID, name: 'ZCode Trust Build', priority: 5 }] },
    }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const result = await previewStartPlan(CREDENTIAL, INFO)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.plans.map(plan => plan.planId)).toEqual([PLAN_ID])
    expect(mockFetch.mock.calls[0]?.[0]).toBe(buildPreviewUrl(INFO))
    const headers = ((mockFetch.mock.calls[0]?.[1] ?? {}) as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer jwt-token')
    expect(headers['X-Device-Mid']).toBe('mid-1')
  })

  it('今日已领取（plans: []）是正常结果，不是失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { plans: [] } }), { status: 200 })))
    const result = await previewStartPlan(CREDENTIAL, INFO)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') expect(result.plans).toEqual([])
  })

  it('401 明确区分登录态失效，不发第二次请求', async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ code: 3001, msg: 'unauthorized' }), { status: 401 }))
    vi.stubGlobal('fetch', mockFetch)
    const result = await previewStartPlan(CREDENTIAL, INFO)
    expect(result.status).toBe('auth-failed')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('缺 zcodejwttoken 时直接报 auth-failed 且不发请求', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const result = await previewStartPlan({ zcodeDeviceMid: 'mid-1' }, INFO)
    expect(result.status).toBe('auth-failed')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('网络异常归类为 failed 而不是静默吞掉', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up') }))
    const result = await previewStartPlan(CREDENTIAL, INFO)
    expect(result.status).toBe('failed')
    if (result.status === 'failed') expect(result.message).toContain('socket hang up')
  })
})
