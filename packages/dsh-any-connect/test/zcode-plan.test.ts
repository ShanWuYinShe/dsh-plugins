import { describe, expect, it, vi } from 'vitest'
import { fetchZCodePlanCredits, parseZCodePlanCredits, planCredits } from '../src/zcode-plan.js'

/** 本机实测的额度响应形状（2026-09-29，ZCode 3.14.4，值已缩放）。 */
function balanceBody(): unknown {
  return {
    code: 0,
    msg: '',
    data: {
      server_time: 1_790_692_543,
      plans: [{
        user_plan_id: 'upl_1',
        plan_id: 'zcode-v3-start-plan-trust-0929',
        name: 'ZCode Trust Build',
        status: 'active',
        starts_at: 1_790_644_854,
        ends_at: 1_790_697_600,
        entitlements: [{ entitlement_id: 'e-1', show_name: 'GLM-5.3-Flash', grant_units: 100, period: 'one_time' }],
      }],
      balances: [{
        entitlement_id: 'e-1',
        plan_id: 'zcode-v3-start-plan-trust-0929',
        show_name: 'GLM-5.3-Flash',
        total_units: 100,
        used_units: 25,
        remaining_units: 75,
        expires_at: 1_790_697_600,
      }],
    },
  }
}

describe('ZCode plan quota', () => {
  it('parses the live response shape into plans and balances', () => {
    const plans = parseZCodePlanCredits(balanceBody())
    expect(plans).toHaveLength(1)
    expect(plans?.[0]?.name).toBe('ZCode Trust Build')
    expect(plans?.[0]?.planId).toBe('zcode-v3-start-plan-trust-0929')
    expect(plans?.[0]?.endsAtMs).toBe(1_790_697_600_000)
    expect(plans?.[0]?.balances[0]).toEqual({
      showName: 'GLM-5.3-Flash',
      totalUnits: 100,
      usedUnits: 25,
      remainingUnits: 75,
      expiresAtMs: 1_790_697_600_000,
    })
  })

  it('refuses a response it does not understand instead of inventing numbers', () => {
    expect(parseZCodePlanCredits({ code: 3001, msg: 'parameter error' })).toBeUndefined()
    expect(parseZCodePlanCredits({ code: 0 })).toBeUndefined()
    expect(parseZCodePlanCredits(null)).toBeUndefined()
    expect(parseZCodePlanCredits('nope')).toBeUndefined()
    // plans 存在但 balances 缺席：仍是可理解的响应，只是没有可用数字。
    expect(parseZCodePlanCredits({ code: 0, data: { plans: [{ plan_id: 'p', name: 'N' }] } }))
      .toEqual([{ planId: 'p', name: 'N', status: 'unknown', balances: [] }])
  })

  it('projects plans onto the shared credit shape with the real plan name', () => {
    const credits = planCredits(parseZCodePlanCredits(balanceBody())!)
    expect(credits.total).toBe(75)
    expect(credits.accounts[0]).toEqual({
      packageName: 'GLM-5.3-Flash',
      planName: 'ZCode Trust Build',
      remain: 75,
      size: 100,
      expiredAt: new Date(1_790_697_600_000).toISOString(),
    })
  })

  it('sends the account JWT with a stable device id and reports HTTP failures', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> })
      return new Response(JSON.stringify(balanceBody()), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const credits = await fetchZCodePlanCredits({
      jwt: 'header.payload.sig',
      deviceMid: 'device-mid-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(credits.total).toBe(75)
    const call = calls[0]!
    expect(call.url).toContain('/api/v1/zcode-plan/billing/balance')
    expect(call.url).toContain('app_version=')
    expect(call.headers['Authorization']).toBe('Bearer header.payload.sig')
    // 服务端按设备 id 识别客户端；随机值会被判成异常流量。
    expect(call.headers['X-Device-Mid']).toBe('device-mid-1')

    await expect(fetchZCodePlanCredits({
      jwt: 'jwt',
      deviceMid: 'mid',
      fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    })).rejects.toThrow(/HTTP 401/)
  })
})
