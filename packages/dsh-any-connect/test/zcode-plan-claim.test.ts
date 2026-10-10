import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CAPTCHA_FAILED_CODE,
  buildClaimBody,
  buildClaimHeaders,
  buildPreviewHeaders,
  buildPreviewUrl,
  claimStartPlan,
  parseClaimResponse,
  parseErrorCode,
  parsePreviewBody,
  previewStartPlan,
  probeAndClaimStartPlan,
  upstreamCode,
  upstreamMessage,
  type StartPlanClaimCredential,
  type StartPlanPlatformInfo,
} from '../src/zcode-plan-claim.js'

/**
 * Start Plan 每日领取的能力边界回归。
 *
 * 核心结论（实测 2026-10-04，见模块头部）：claim 需要阿里云验证码，token 由
 * 客户端渲染进程签发、纯 Node 无法生成，因此**全自动领取不可能**。测试要钉死
 * 两件事：探测分支都能正确分类（尤其 401 与 3007 不能混为一谈），以及无
 * captcha 时**根本不发请求**——绝不能把 captcha 错误伪装成"已领取"。
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

  it('claim 头按客户端契约带 captcha / 版本 / 平台三项', () => {
    const headers = buildClaimHeaders(CREDENTIAL, INFO, 'captcha-param-xyz')
    expect(headers['Authorization']).toBe('Bearer jwt-token')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-Aliyun-Captcha-Verify-Param']).toBe('captcha-param-xyz')
    expect(headers['X-ZCode-App-Version']).toBe('3.4.0')
    expect(headers['X-Platform']).toBe('darwin-arm64')
    expect(headers['X-Device-Mid']).toBe('mid-1')
  })

  it('claim body 只含 plan_id', () => {
    expect(JSON.parse(buildClaimBody(PLAN_ID))).toEqual({ plan_id: PLAN_ID })
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

describe('claim 响应分类（captcha-required 与 captcha-rejected 必须分开）', () => {
  it('成功：code 0 + data.plan 映射为 claimed', () => {
    const result = parseClaimResponse(200, { code: 0, data: { plan: { plan_id: PLAN_ID, name: 'ZCode Trust Build' } } })
    expect(result).toEqual({ status: 'claimed', planId: PLAN_ID, planName: 'ZCode Trust Build' })
  })

  it('成功但 plan 字段缺失：仍是 claimed，planId 为空串而不是编造', () => {
    expect(parseClaimResponse(200, { code: 0, data: {} })).toEqual({ status: 'claimed', planId: '' })
  })

  it('实测形状 HTTP 400 + code 3007 -> captcha-rejected（不是 failed、更不是 claimed）', () => {
    const result = parseClaimResponse(400, { code: CAPTCHA_FAILED_CODE, msg: 'captcha verify failed' })
    expect(result.status).toBe('captcha-rejected')
    if (result.status === 'captcha-rejected') expect(result.message).toBe('captcha verify failed')
  })

  it('HTTP 401 与 body code 401 都归 auth-failed', () => {
    expect(parseClaimResponse(401, { code: 3001, msg: 'unauthorized' }).status).toBe('auth-failed')
    expect(parseClaimResponse(200, { code: 401, msg: 'token expired' }).status).toBe('auth-failed')
  })

  it('空 message 时状态码渲染为 HTTP_401/HTTP_500 形，不触发宿主 401/403 正则', () => {
    expect(parseClaimResponse(401, { code: 3001, msg: '' })).toEqual({ status: 'auth-failed', message: 'HTTP_401' })
    const failed = parseClaimResponse(500, { code: 0, data: {}, msg: '' })
    expect(failed).toEqual({ status: 'failed', message: 'HTTP_500' })
  })

  it('其他 HTTP 错误与非 0 code 归 failed，且保留上游 msg', () => {
    const http = parseClaimResponse(500, { code: 500, msg: 'boom' })
    expect(http.status).toBe('failed')
    if (http.status === 'failed') expect(http.message).toContain('HTTP_500')
    const code = parseClaimResponse(200, { code: 3006, msg: 'model not allowed' })
    expect(code.status).toBe('failed')
    if (code.status === 'failed') expect(code.message).toContain('3006')
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

describe('claimStartPlan（无 captcha 不发请求，这是硬约束）', () => {
  it('未提供 captcha：短路为 captcha-required，一次请求都不发', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const result = await claimStartPlan(CREDENTIAL, INFO, PLAN_ID)
    expect(result.status).toBe('captcha-required')
    if (result.status === 'captcha-required') {
      expect(result.planId).toBe(PLAN_ID)
      // 文案必须说清"为什么不能全自动"，否则用户会以为插件坏了。
      expect(result.message).toContain('验证码')
      expect(result.message).toContain('AliyunCaptcha')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('空白 captcha 与未提供同义，同样不发请求', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const result = await claimStartPlan(CREDENTIAL, INFO, PLAN_ID, '   ')
    expect(result.status).toBe('captcha-required')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('携带 captcha 时才真发 POST，头/体按客户端契约', async () => {
    const mockFetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: { plan: { plan_id: PLAN_ID, name: 'ZCode Trust Build' } },
    }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const result = await claimStartPlan(CREDENTIAL, INFO, PLAN_ID, 'captcha-param-xyz')
    expect(result.status).toBe('claimed')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch.mock.calls[0]![0]).toBe('https://zcode.z.ai/api/v1/zcode-plan/billing/claim')
    const init = (mockFetch.mock.calls[0]![1] ?? {}) as RequestInit
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Aliyun-Captcha-Verify-Param']).toBe('captcha-param-xyz')
    expect(headers['X-ZCode-App-Version']).toBe('3.4.0')
    expect(headers['X-Platform']).toBe('darwin-arm64')
    expect(JSON.parse(String(init.body))).toEqual({ plan_id: PLAN_ID })
  })

  it('上游 400 code 3007 -> captcha-rejected，且带上请求的 planId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 3007, msg: 'captcha verify failed' }),
      { status: 400 },
    )))
    const result = await claimStartPlan(CREDENTIAL, INFO, PLAN_ID, 'stale-captcha')
    expect(result.status).toBe('captcha-rejected')
    if (result.status === 'captcha-rejected') expect(result.planId).toBe(PLAN_ID)
  })

  it('401 -> auth-failed，不谎报已领取', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 3001, msg: 'unauthorized' }), { status: 401 })))
    const result = await claimStartPlan(CREDENTIAL, INFO, PLAN_ID, 'captcha-param-xyz')
    expect(result.status).toBe('auth-failed')
  })

  it('缺凭据与空 plan_id 都不发请求', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    expect((await claimStartPlan({}, INFO, PLAN_ID)).status).toBe('auth-failed')
    expect((await claimStartPlan(CREDENTIAL, INFO, '  ')).status).toBe('failed')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('probeAndClaimStartPlan（探测自动 + 领取手动的汇总）', () => {
  it('有待领取项时，汇总结果是 captcha-required（不会伪装成已自动领取）', async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: { plans: [{ plan_id: 'p2', priority: 1 }, { plan_id: PLAN_ID, priority: 9, name: 'ZCode Trust Build' }] },
    }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const result = await probeAndClaimStartPlan(CREDENTIAL, INFO)
    expect(result.preview.status).toBe('ok')
    // 取优先级最高的一项发起领取尝试。
    expect(result.claim?.status).toBe('captcha-required')
    if (result.claim?.status === 'captcha-required') expect(result.claim.planId).toBe(PLAN_ID)
    // 只有 preview 一次请求：没有 captcha 就不该有第二次调用。
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('今日已领取：不给 claim 结果（没有可领的东西）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { plans: [] } }), { status: 200 })))
    const result = await probeAndClaimStartPlan(CREDENTIAL, INFO)
    expect(result.preview.status).toBe('ok')
    expect(result.claim).toBeUndefined()
  })

  it('探测失败时不尝试领取', async () => {
    const mockFetch = vi.fn(async () => new Response('nope', { status: 500 }))
    vi.stubGlobal('fetch', mockFetch)
    const result = await probeAndClaimStartPlan(CREDENTIAL, INFO)
    expect(result.preview.status).toBe('failed')
    expect(result.claim).toBeUndefined()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
