import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyZCodePlanOverride, effectiveZCodePlan, isNightFreeEligiblePlan } from '../src/zcode-plan-store.js'
import { parseZCodeAuth } from '../src/auth.js'

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

describe('生效计划计算（按变体固定语义）', () => {
  it('coding 槽位保留具体 coding 语义，账号计划一律归入抽象 coding', () => {
    expect(effectiveZCodePlan('individual-coding-plan', 'coding-plan')).toBe('individual-coding-plan')
    expect(effectiveZCodePlan('team-coding-plan', 'coding-plan')).toBe('team-coding-plan')
    // 客户端选了 start-plan / off-peak / 读不到：coding 变体绝不改走专属通道。
    expect(effectiveZCodePlan('start-plan', 'coding-plan')).toBe('coding-plan')
    expect(effectiveZCodePlan('off-peak', 'coding-plan')).toBe('coding-plan')
    expect(effectiveZCodePlan(undefined, 'coding-plan')).toBe('coding-plan')
  })

  it('start 槽位恒为 start-plan', () => {
    expect(effectiveZCodePlan('start-plan', 'start-plan')).toBe('start-plan')
    expect(effectiveZCodePlan('individual-coding-plan', 'start-plan')).toBe('start-plan')
    expect(effectiveZCodePlan(undefined, 'start-plan')).toBe('start-plan')
  })

  it('夜间免费资格只属于 coding 语义', () => {
    expect(isNightFreeEligiblePlan('individual-coding-plan')).toBe(true)
    expect(isNightFreeEligiblePlan('team-coding-plan')).toBe(true)
    expect(isNightFreeEligiblePlan('off-peak')).toBe(true)
    expect(isNightFreeEligiblePlan('coding-plan')).toBe(true)
    expect(isNightFreeEligiblePlan(undefined)).toBe(true)
    expect(isNightFreeEligiblePlan('start-plan')).toBe(false)
  })
})

describe('凭据计划折算（变体语义折进 zcodePlan）', () => {
  it('coding 变体：账号计划选择被归入 coding，绝不保留 start-plan', () => {
    expect(applyZCodePlanOverride({ zcodePlan: 'start-plan' }, 'coding-plan')).toEqual({ zcodePlan: 'individual-coding-plan' })
    expect(applyZCodePlanOverride({ zcodePlan: 'off-peak' }, 'coding-plan')).toEqual({ zcodePlan: 'individual-coding-plan' })
    expect(applyZCodePlanOverride({ zcodePlan: 'team-coding-plan' }, 'coding-plan')).toEqual({ zcodePlan: 'team-coding-plan' })
    expect(applyZCodePlanOverride({}, 'coding-plan')).toEqual({ zcodePlan: 'individual-coding-plan' })
  })

  it('start 变体：一律 start-plan', () => {
    expect(applyZCodePlanOverride({ zcodePlan: 'individual-coding-plan' }, 'start-plan')).toEqual({ zcodePlan: 'start-plan' })
    expect(applyZCodePlanOverride({}, 'start-plan')).toEqual({ zcodePlan: 'start-plan' })
    expect(applyZCodePlanOverride({ zcodePlan: 'start-plan' }, 'start-plan')).toEqual({ zcodePlan: 'start-plan' })
  })

  it('已是目标语义的凭据原样返回（保持引用相等）', () => {
    const credential = { zcodePlan: 'individual-coding-plan' as const }
    expect(applyZCodePlanOverride(credential, 'coding-plan')).toBe(credential)
  })
})

describe('与凭据解析的衔接', () => {
  it('同一份凭据文档：coding 变体与 start 变体各取各的计划语义', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zc-plan-cred-'))
    CLEANUP.push(() => rm(dir, { recursive: true, force: true }))
    await writeFile(join(dir, 'setting.json'), JSON.stringify({
      providerFamilyDomain: 'bigmodel',
      providerFamilyConnectionSelections: { bigmodel: { kind: 'start-plan' } },
    }))
    const credPath = join(dir, 'credentials.json')
    await writeFile(credPath, JSON.stringify({
      'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:42:api-key': 'id.secret',
    }))
    const parsed = parseZCodeAuth(await readFile(credPath, 'utf8'), credPath)
    expect(parsed?.zcodePlan).toBe('start-plan')
    // 客户端选了 start-plan：coding 变体仍按 coding 语义走普通通道。
    expect(applyZCodePlanOverride(parsed!, 'coding-plan').zcodePlan).toBe('individual-coding-plan')
    // start 变体固定 start-plan，走专属通道。
    expect(applyZCodePlanOverride(parsed!, 'start-plan').zcodePlan).toBe('start-plan')
  })
})
