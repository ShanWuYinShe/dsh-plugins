/**
 * ZCode 桌面客户端内置目录的只读访问：Coding Plan 的官方模型白名单。
 *
 * 权威来源是客户端安装目录里的 provider 配置
 * （`<app>/Contents/Resources/config/provider/zcode-builtin.json`）：
 * `providerConfigRules.providerRules[]` 中 accountType 为 `bigmodel`、providerId
 * 为 `account:bigmodel-<kind>-coding-plan` 的条目，其 `config.builtinModelIds`
 * 就是客户端向 Coding Plan 用户展示的模型名单（2026-10-06 实测 revision 30：
 * GLM-5.3、GLM-5.3-Flash）。
 *
 * 上游 `open.bigmodel.cn/api/paas/v4/models` 是**开放平台 API** 的模型目录，
 * 不是 Coding Plan 的产品面：实测对 coding-plan key 返回 11 个 id，其中 7 个
 * 在客户端配置里完全没有绑定到 coding-plan；端点层放行（200）≠ 订阅覆盖，
 * 费率/额度语义未经验证。所以上游目录必须经这份白名单过滤后才可展示。
 *
 * 拿不到白名单（客户端未安装/文件不可读/结构演进）时返回 `undefined`，
 * 调用方应回退已注册名单——宁可少展示，不展示未经验证的模型。
 *
 * @module dsh-any-connect/zcode-builtin-catalog
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** ZCode 客户端内置 provider 配置在 macOS app bundle 内的相对路径。 */
const BUILTIN_CONFIG_RELATIVE = ['Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json'] as const

/**
 * 环境变量覆盖口：显式指定 zcode-builtin.json 的路径。
 * 供非标准安装位置与非 macOS 平台使用（其余平台的安装路径未经实测，不猜）。
 */
const BUILTIN_CONFIG_ENV = 'ZCODE_BUILTIN_CONFIG'

/** macOS 上 ZCode.app 的标准安装位置（实测 3.14.4）。 */
function darwinBuiltinConfigCandidates(): string[] {
  return [
    '/Applications/ZCode.app',
    join(homedir(), 'Applications', 'ZCode.app'),
  ].map(dir => join(dir, ...BUILTIN_CONFIG_RELATIVE))
}

/** 平台相关的候选路径；未经实测验证的平台返回空（降级，不猜路径）。 */
function builtinConfigCandidates(): string[] {
  const override = process.env[BUILTIN_CONFIG_ENV]
  if (override !== undefined && override.trim() !== '') {
    return [override]
  }
  if (process.platform === 'darwin') return darwinBuiltinConfigCandidates()
  return []
}

/** Provider 条目形状（zcode-builtin.json revision 30；未知结构一律容忍）。 */
interface ProviderRuleShape {
  providerId?: unknown
  config?: {
    access?: { accountType?: unknown } & Record<string, unknown>
    builtinModelIds?: unknown
  } & Record<string, unknown>
}

/**
 * 从已解析的 zcode-builtin.json 提取 Coding Plan 白名单（小写 id 集合）。
 *
 * 只纳入 `accountType === 'bigmodel'` 的 coding-plan 条目（Z.AI 系走不同
 * 域名，不属这条通道）；找不到任何条目或解析不出任何模型 id 时返回
 * `undefined`——那更像客户端结构演进，而不是官方真的发布了零模型订阅，
 * 降级比显示空分组安全。
 */
export function codingPlanWhitelistFromConfig(config: unknown): ReadonlySet<string> | undefined {
  const rules = (config as { config?: { providerConfigRules?: { providerRules?: unknown } } } | null)
    ?.config?.providerConfigRules?.providerRules
  if (!Array.isArray(rules)) return undefined
  const ids = new Set<string>()
  for (const rule of rules) {
    const provider = rule as ProviderRuleShape
    if (typeof provider?.providerId !== 'string') continue
    if (!/^account:bigmodel-[a-z0-9-]+-coding-plan$/.test(provider.providerId)) continue
    if (provider.config?.access?.accountType !== 'bigmodel') continue
    const builtin = provider.config?.builtinModelIds
    if (!Array.isArray(builtin)) continue
    for (const id of builtin) {
      if (typeof id === 'string' && id.trim() !== '') ids.add(id.trim().toLowerCase())
    }
  }
  return ids.size > 0 ? ids : undefined
}

/**
 * 读取本机 ZCode 客户端的 Coding Plan 白名单；不可得时返回 undefined。
 *
 * 每次调用都重新读盘（约 180KB，调用方每小时至多一次）：客户端升级后名单
 * 无需重启插件即生效。任何读取/解析失败都静默降级——这里没有比「回退已
 * 注册名单」更正确的答案。
 */
export function readZcodeCodingPlanWhitelist(): ReadonlySet<string> | undefined {
  for (const path of builtinConfigCandidates()) {
    try {
      if (!existsSync(path)) continue
      const parsed = codingPlanWhitelistFromConfig(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      if (parsed !== undefined) return parsed
    } catch {
      // 单个候选失败不致命：换下一个候选，或最终 undefined。
    }
  }
  return undefined
}
