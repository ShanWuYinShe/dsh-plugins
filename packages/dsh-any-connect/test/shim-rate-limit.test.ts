import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkBuddyCredentialStore } from '../src/auth.js'
import { WorkBuddyCatalog } from '../src/catalog.js'
import { createWorkBuddyShim, type WorkBuddyShim } from '../src/shim.js'
import { RateLimitLedger } from '../src/rate-limit.js'
import { CN_VARIANT } from '../src/variants.js'
import type { WorkBuddyChatResult } from '../src/upstream.js'

/**
 * shim → 限流台账的接线回归。
 *
 * 这块的意义在于「观测发生在真正看到上游响应的那一层」：429 的恢复时刻只存在于
 * 上游响应头里，穿过 shim 时不落账就永远丢了（模型通道只把失败折叠成一次重试）。
 * 因此这里走真实 HTTP + 真实 shim，断言台账读得到上游说过的话。
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

interface Harness {
  shim: WorkBuddyShim
  ledger: RateLimitLedger
}

async function startShim(
  upstreamResponse: () => WorkBuddyChatResult,
  options: { providerId?: string } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-rate-'))
  CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
  const desktop = join(dir, 'workbuddy-desktop.info')
  await writeFile(desktop, JSON.stringify({
    auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, domain: 'www.codebuddy.cn' },
    account: { uid: 'uid-1' },
  }))
  const store = new WorkBuddyCredentialStore({
    variant: CN_VARIANT,
    desktopPath: desktop,
    ownPath: join(dir, 'own.json'),
    refresh: async () => ({ accessToken: 'unused' }),
  })
  const ledger = new RateLimitLedger()
  const shim = createWorkBuddyShim({
    kind: 'workbuddy',
    ...options.providerId === undefined ? {} : { providerId: options.providerId },
    store,
    catalog: new WorkBuddyCatalog(),
    client: {
      async chatStream(): Promise<WorkBuddyChatResult> {
        return upstreamResponse()
      },
    },
    rateLimits: ledger,
  })
  await shim.ready
  CLEANUP.push(() => shim.close())
  return { shim, ledger }
}

/** POST one chat completion; the answer itself is irrelevant here. */
async function postChat(harness: Harness): Promise<Response> {
  return await fetch(`${harness.shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${harness.shim.token()}` },
    body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  })
}

describe('shim 把上游限流写进台账', () => {
  it('429 + Retry-After → 台账记录恢复时刻与模型', async () => {
    const harness = await startShim(() => ({
      ok: false,
      status: 429,
      kind: 'soft_rate',
      message: 'rate limited',
      headers: new Headers({ 'retry-after': '90' }),
    }))
    const before = Date.now()
    const response = await postChat(harness)
    expect(response.status).toBe(429) // 宿主仍按限流语义重试

    const active = harness.ledger.activeFor('workbuddy')
    expect(active, '429 必须落账，否则恢复时刻永久丢失').toBeDefined()
    expect(active!.status).toBe(429)
    expect(active!.model).toBe('glm-5.3')
    expect(active!.resetAtMs).toBeGreaterThanOrEqual(before + 89_000)
  })

  it('429 + WorkBuddy code:6004 文案里的 UTC+8 恢复时刻 → 台账记录', async () => {
    const resetAt = new Date(Date.now() + 2 * 3_600_000)
    // 文案里的时刻按 UTC+8 书写（WorkBuddy 实测口径），秒级精度。
    const beijing = new Date(resetAt.getTime() + 8 * 3_600_000)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp = `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`
      + ` ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`
    const body = JSON.stringify({
      code: 6004,
      msg: `usage exceeds frequency limit, but don't worry, your usage will reset at ${stamp} UTC+8,`
        + ' alternatively, you can switch to the other models to continue using it.',
      requestId: '46d4c00997bb45d1aa9aa9806bd1cbea',
    })
    const harness = await startShim(() => ({ ok: false, status: 429, kind: 'soft_rate', message: body }))
    await postChat(harness)

    const active = harness.ledger.activeFor('workbuddy')
    expect(active).toBeDefined()
    // 文案只到秒，允许 2s 内的截断误差。
    expect(Math.abs(active!.resetAtMs! - resetAt.getTime())).toBeLessThan(2_000)
  })

  it('429 但没有恢复头 → 记录「被限了」，不编造恢复时刻', async () => {
    const harness = await startShim(() => ({ ok: false, status: 429, kind: 'soft_rate', message: 'slow down' }))
    await postChat(harness)
    const active = harness.ledger.activeFor('workbuddy')
    expect(active).toBeDefined()
    expect(active!.resetAtMs).toBeUndefined()
  })

  it('随后一次成功请求 → 台账自动清掉（限流已解除的实证）', async () => {
    let next: WorkBuddyChatResult = { ok: false, status: 429, kind: 'soft_rate', message: 'slow down' }
    const harness = await startShim(() => next)
    await postChat(harness)
    expect(harness.ledger.activeFor('workbuddy')).toBeDefined()

    next = {
      ok: true,
      response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }
    await postChat(harness)
    expect(harness.ledger.activeFor('workbuddy'), '成功请求证明通道已开').toBeUndefined()
  })

  it('非限流失败（500）不落账', async () => {
    const harness = await startShim(() => ({ ok: false, status: 500, kind: 'server', message: 'boom' }))
    await postChat(harness)
    expect(harness.ledger.activeFor('workbuddy')).toBeUndefined()
  })

  it('按 providerId 分账：两个变体互不覆盖', async () => {
    const zcode = await startShim(
      () => ({ ok: false, status: 429, kind: 'soft_rate', message: 'slow down' }),
      { providerId: 'zcode' },
    )
    await postChat(zcode)
    expect(zcode.ledger.activeFor('zcode')).toBeDefined()
    expect(zcode.ledger.activeFor('workbuddy')).toBeUndefined()
  })

  // 这条锁住台账的**纯观测**性质：它只记录、不拦截。
  // 用户明确要求「只是给个提示，方便用户查看」——如果台账参与请求门禁，
  // 用户会看到「明明还能用却被插件拦下」这种无法自行解除的假故障。
  it('台账只观测不拦截：已有活跃限流观测时，请求照常发往上游', async () => {
    let upstreamCalls = 0
    let next: WorkBuddyChatResult = { ok: false, status: 429, kind: 'soft_rate', message: 'slow down' }
    const harness = await startShim(() => {
      upstreamCalls += 1
      return next
    })

    // 第一次：撞到 429，台账记下「被限」。
    await postChat(harness)
    expect(harness.ledger.activeFor('workbuddy')).toBeDefined()
    expect(upstreamCalls).toBe(1)

    // 第二次：台账里仍有活跃限流，但请求必须照样打到上游。
    next = {
      ok: true,
      response: new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    }
    const response = await postChat(harness)
    expect(upstreamCalls, '限流观测不得阻断后续请求').toBe(2)
    expect(response.status, '上游放行时插件也必须放行').toBe(200)
    // 成功后台账自动清空——解除由上游事实驱动，不是插件猜的。
    expect(harness.ledger.activeFor('workbuddy')).toBeUndefined()
  })

  it('X-RateLimit-Reset 也能被识别（OpenRouter/Kimi 口径）', async () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 120
    const harness = await startShim(() => ({
      ok: false,
      status: 429,
      kind: 'soft_rate',
      message: 'rate limited',
      headers: new Headers({ 'x-ratelimit-reset': String(resetSeconds) }),
    }))
    await postChat(harness)
    const active = harness.ledger.activeFor('workbuddy')
    expect(active!.resetAtMs).toBe(resetSeconds * 1000)
  })
})
