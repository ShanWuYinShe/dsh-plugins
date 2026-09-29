import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZCodeUpstreamClient, parseZCodeAuth, type WorkBuddyCredential } from '../src/index.js'

/**
 * 「同时支持 code plan 与 start plan」的核心保证：不论客户端选了哪条账号计划，
 * 模型请求与额度查询都落在账户上的 coding-plan key 与普通 ZCode 通道上。
 * 账号计划（start-plan / off-peak）本身不写 api-key 条目，所以这里验证的是
 * 「回落规则选对了 key」这件事——正是它让 Start Plan 账号按普通 ZCode 使用。
 */
const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

describe('ZCode 账号计划与编码计划共存', () => {
  /** 写一份「选择 + 凭据」的临时 zcode home，返回凭据文件路径。 */
  async function fakeZCodeHome(selection: { family: string; kind: string }, keys: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'zc-dual-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'setting.json'), JSON.stringify({
      providerFamilyDomain: selection.family,
      providerFamilyConnectionSelections: { [selection.family]: { kind: selection.kind } },
    }))
    const credPath = join(dir, 'credentials.json')
    await writeFile(credPath, JSON.stringify(keys))
    return credPath
  }

  const keys = {
    'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:57271768622479063:api-key': 'team-id.team-secret',
    'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:57271768622479063:api-key': 'ind-id.ind-secret',
  }

  it('选择 code plan 时用对应那把 key，计划如实标识', async () => {
    const path = await fakeZCodeHome({ family: 'bigmodel', kind: 'individual-coding-plan' }, keys)
    const parsed = parseZCodeAuth(await readFile(path, 'utf8'), path)
    expect(parsed?.zcodePlan).toBe('individual-coding-plan')
    expect(parsed?.accessToken).toBe('ind-id.ind-secret')
  })

  it('选择 start plan 时回落到同 family 的 coding-plan key，计划仍标为 start-plan', async () => {
    // Start Plan 在凭据里没有自己的 api-key 条目——这正是它能「按普通 ZCode
    // 150% 额度使用」的前提：请求由账户上的 coding-plan key 签名。
    const path = await fakeZCodeHome({ family: 'bigmodel', kind: 'start-plan' }, keys)
    const parsed = parseZCodeAuth(await readFile(path, 'utf8'), path)
    expect(parsed?.zcodePlan).toBe('start-plan')
    // 个人版优先：团队 key 在服务端需要 bigmodel-organization /
    // bigmodel-project 身份头（本包不发），个人版不需要，是更稳的默认。
    expect(parsed?.accessToken).toBe('ind-id.ind-secret')
  })

  it('只有 team key 时回落到它（没有个人版可退）', async () => {
    const onlyTeam = {
      'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:57271768622479063:api-key': 'team-id.team-secret',
    }
    const path = await fakeZCodeHome({ family: 'bigmodel', kind: 'start-plan' }, onlyTeam)
    const parsed = parseZCodeAuth(await readFile(path, 'utf8'), path)
    expect(parsed?.zcodePlan).toBe('start-plan')
    expect(parsed?.accessToken).toBe('team-id.team-secret')
  })

  it('选择 code plan 但同 family 只有另一把 key 时仍可用', async () => {
    const onlyTeam = {
      'account-provider:coding-plan:account:bigmodel-team-coding-plan:account:57271768622479063:api-key': 'team-id.team-secret',
    }
    const path = await fakeZCodeHome({ family: 'bigmodel', kind: 'individual-coding-plan' }, onlyTeam)
    const parsed = parseZCodeAuth(await readFile(path, 'utf8'), path)
    expect(parsed?.zcodePlan).toBe('individual-coding-plan')
    expect(parsed?.accessToken).toBe('team-id.team-secret')
  })

  it('额度查询始终打 coding-plan 订阅接口，与计划无关', async () => {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ code: 200, data: [{ productName: 'GLM Coding Pro', status: 'VALID' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const client = new ZCodeUpstreamClient()
      const base: WorkBuddyCredential = {
        accessToken: 'id.secret',
        refreshToken: '',
        expiresAtMs: Number.MAX_SAFE_INTEGER,
        domain: 'bigmodel.cn',
        uid: 'u',
        source: 'desktop',
      }
      for (const plan of ['individual-coding-plan', 'start-plan'] as const) {
        calls.length = 0
        const credits = await client.fetchCredits({ ...base, zcodePlan: plan })
        // 模型请求固定走 coding-plan 通道，额度显示必须同口径。
        expect(calls).toEqual(['https://bigmodel.cn/api/biz/subscription/list'])
        expect(credits.accounts[0]?.planName).toBe('GLM Coding Pro')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})