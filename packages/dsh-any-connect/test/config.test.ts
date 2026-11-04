import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'
import { readZcodeCodingPlanWhitelist } from '../src/zcode-builtin-catalog.js'
import { OpenCodeUpstreamClient } from '../src/upstream-opencode.js'

/**
 * Config 契约回归（RULE-059/060）：
 * - schema 默认值完整：六个字段未设置时都是空串，消费方按「未设置」处理，
 *   而不是字段整个缺席（那会让 `?.` 成为可选性来源）；
 * - 两条部署相关路径（ZCODE_BUILTIN_CONFIG / OPENCODE_MODELS_CACHE）已经是
 *   Config 字段，优先级为「Config > 环境变量 > 平台默认」。
 */

const CLEANUP: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(CLEANUP.splice(0).map(clean => clean()))
})

const CONFIG_FIELDS = [
  'authFile',
  'authFileAI',
  'authFileZCode',
  'authFileOpenCode',
  'zcodeBuiltinConfig',
  'openCodeModelsCache',
] as const

describe('Config schema 默认值', () => {
  it('六个字段缺省时都是空串（不是整个缺席）', () => {
    const parsed = Config({}) as unknown as Record<(typeof CONFIG_FIELDS)[number], { get(): unknown }>
    for (const field of CONFIG_FIELDS) {
      expect(parsed[field], `${field} 必须存在（schema 有 .default('')）`).toBeDefined()
      expect(parsed[field]!.get(), `${field} 未设置时归一为空串`).toBe('')
    }
  })

  it('显式值原样进入 volatile 引用（Loader 热更新读的是同一份引用）', () => {
    const parsed = Config({ zcodeBuiltinConfig: '/opt/zcode/zcode-builtin.json' }) as unknown as Record<(typeof CONFIG_FIELDS)[number], { get(): unknown }>
    expect(parsed.zcodeBuiltinConfig.get()).toBe('/opt/zcode/zcode-builtin.json')
    expect(parsed.openCodeModelsCache.get()).toBe('')
  })
})

/** 一份能解析出 Coding Plan 白名单的 zcode-builtin.json。 */
function builtinConfigDocument(ids: readonly string[]): string {
  return JSON.stringify({
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: 'account:bigmodel-individual-coding-plan',
          config: { access: { accountType: 'bigmodel' }, builtinModelIds: ids },
        }],
      },
    },
  })
}

describe('zcodeBuiltinConfig 优先级', () => {
  it('Config 路径优先于 ZCODE_BUILTIN_CONFIG 环境变量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-config-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const fromConfig = join(root, 'config-path.json')
    const fromEnv = join(root, 'env-path.json')
    await writeFile(fromConfig, builtinConfigDocument(['glm-config']))
    await writeFile(fromEnv, builtinConfigDocument(['glm-env']))
    vi.stubEnv('ZCODE_BUILTIN_CONFIG', fromEnv)

    expect([...(readZcodeCodingPlanWhitelist(fromConfig) ?? [])]).toEqual(['glm-config'])
    // 空串 = 未设置：回落到环境变量（与 authFile 的「空串走平台默认」同一语义）。
    expect([...(readZcodeCodingPlanWhitelist('') ?? [])]).toEqual(['glm-env'])
  })
})

describe('openCodeModelsCache 优先级', () => {
  const SPEC_DOCUMENT = (name: string): string => JSON.stringify({
    opencode: {
      npm: '@ai-sdk/openai-compatible',
      models: { 'test-free': { name, limit: { context: 123456, output: 4321 } } },
    },
  })

  it('Config 缓存路径优先于 OPENCODE_MODELS_CACHE 环境变量', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-any-connect-config-'))
    CLEANUP.push(() => rm(root, { recursive: true, force: true }))
    const fromConfig = join(root, 'config-models.json')
    const fromEnv = join(root, 'env-models.json')
    await writeFile(fromConfig, SPEC_DOCUMENT('Configured Name'))
    await writeFile(fromEnv, SPEC_DOCUMENT('Env Name'))
    vi.stubEnv('OPENCODE_MODELS_CACHE', fromEnv)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'test-free' }],
    }), { status: 200 })))

    // 传函数：配置是 volatile 的，客户端每轮解析时读取当前值。
    const client = new OpenCodeUpstreamClient({ cachePath: () => fromConfig })
    const models = await client.fetchModels({ accessToken: 'public' } as never)
    expect(models.find(model => model.id === 'test-free')?.name).toBe('Configured Name')

    // 空串 = 未设置：回落到环境变量。
    const fromEnvClient = new OpenCodeUpstreamClient({ cachePath: () => '' })
    const envModels = await fromEnvClient.fetchModels({ accessToken: 'public' } as never)
    expect(envModels.find(model => model.id === 'test-free')?.name).toBe('Env Name')
  })
})
