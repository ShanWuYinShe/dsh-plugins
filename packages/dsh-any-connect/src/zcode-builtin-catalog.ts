/**
 * ZCode 桌面客户端内置目录的只读访问：Coding Plan 的官方模型白名单。
 *
 * 权威来源是 ZCode 的 provider 配置（`zcode-builtin.json`）中的
 * `providerConfigRules.providerRules[]`：accountType 为 `bigmodel`、providerId
 * 为 `account:bigmodel-<kind>-coding-plan` 的条目，其 `config.builtinModelIds`
 * 就是客户端向 Coding Plan 用户展示的模型名单。
 *
 * 读取优先级（命中即止）：
 * 1. 用户数据目录下的运行时缓存 `<zcode-home>/runtime/provider/<platform>-<arch>/<version>/<endpoint>/zcode-builtin.json`。
 *    ZCode 4.0 起官方通过远端 release 热更新这份缓存（实测 revision 48 已含
 *    GLM-5.4），而安装目录里的静态副本仍停留在发版时的 revision（44，无 5.4）。
 *    必须先读缓存，否则新上架模型永远进不了选择框。
 * 2. 安装目录里的静态副本（`zcode-builtin.json`，见下方平台路径）。
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

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findWslWindowsUserDirs, isWsl, windowsPathForWsl } from './wsl.js'

/** ZCode 客户端内置 provider 配置在 macOS app bundle 内的相对路径。 */
const BUILTIN_CONFIG_RELATIVE = ['Contents', 'Resources', 'config', 'provider', 'zcode-builtin.json'] as const

/**
 * ZCode 运行时热更新缓存的相对路径片段：`<zcode-home>/runtime/provider/<platform>/<version>/<endpoint>/zcode-builtin.json`。
 * 结构随平台/版本/endpoint 分层，endpoint 目录名不可猜，故按两层目录递归。
 */
const RUNTIME_PROVIDER_RELATIVE = ['runtime', 'provider'] as const
const BUILTIN_FILENAME = 'zcode-builtin.json'

/**
 * 环境变量覆盖口：显式指定 zcode-builtin.json 的路径。
 * 供非标准安装位置与非 macOS 平台使用（其余平台的安装路径未经实测，不猜）。
 *
 * 优先级：插件 `Config.zcodeBuiltinConfig`（可从 patch 改、随 profile 迁移）>
 * 本环境变量（部署/调试的临时口）> 平台候选路径。
 */
const BUILTIN_CONFIG_ENV = 'ZCODE_BUILTIN_CONFIG'

/** macOS 上 ZCode.app 的标准安装位置（实测 3.14.4）。 */
function darwinBuiltinConfigCandidates(home: string = homedir()): string[] {
  return [
    '/Applications/ZCode.app',
    join(home, 'Applications', 'ZCode.app'),
  ].map(dir => join(dir, ...BUILTIN_CONFIG_RELATIVE))
}

function windowsBuiltinConfigCandidates(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const localAppData = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
  const appData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
  return [
    join(localAppData, 'Programs', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
    join(localAppData, 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
    join(appData, 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
    join(programFiles, 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
  ]
}

function linuxBuiltinConfigCandidates(home: string = homedir()): string[] {
  return [
    '/opt/ZCode/resources/config/provider/zcode-builtin.json',
    '/usr/share/zcode/resources/config/provider/zcode-builtin.json',
    join(home, '.local', 'share', 'zcode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
  ]
}

function wslBuiltinConfigCandidates(
  env: NodeJS.ProcessEnv = process.env,
  usersRoots?: readonly string[],
): string[] {
  const candidates: string[] = []

  // 1. 系统级候选路径（全系统安装）
  for (const drive of ['c', 'd']) {
    candidates.push(
      join('/mnt', drive, 'Program Files', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
      join('/mnt', drive, 'Program Files (x86)', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
    )
  }

  // 2. Windows 用户级候选路径（单用户安装）
  for (const userDir of findWslWindowsUserDirs(env, undefined, usersRoots)) {
    candidates.push(
      join(userDir, 'AppData', 'Local', 'Programs', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
      join(userDir, 'AppData', 'Local', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
      join(userDir, 'AppData', 'Roaming', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
    )
  }

  // 3. 环境变量覆盖
  const programFiles = windowsPathForWsl(env['ProgramFiles'])
  if (programFiles) {
    candidates.push(join(programFiles, 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'))
  }
  const localAppData = windowsPathForWsl(env['LOCALAPPDATA'])
  if (localAppData) {
    candidates.push(
      join(localAppData, 'Programs', 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
      join(localAppData, 'ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json'),
    )
  }

  return [...new Set(candidates)]
}

/** 依据 semver 版本串降序排列；非纯版本目录排最后（如 0.0.0-dev）。 */
function byVersionDesc(a: string, b: string): number {
  const parse = (name: string): number[] => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/u.exec(name)
    return m === null ? [] : [Number(m[1]), Number(m[2]), Number(m[3])]
  }
  const av = parse(a)
  const bv = parse(b)
  if (av.length === 0 || bv.length === 0) return av.length === 0 ? 1 : -1
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return bv[i]! - av[i]!
  }
  return 0
}

/**
 * 枚举用户数据目录下的运行时热更新缓存。
 *
 * 返回按版本号降序排列的最新配置优先（多版本共存时热更新总落在最新版本）。
 * 目录结构为 `<home>/runtime/provider/<platform-arch>/<version>/<endpoint>/zcode-builtin.json`。
 */
function runtimeProviderCandidates(home: string): string[] {
  const providerRoot = join(home, ...RUNTIME_PROVIDER_RELATIVE)
  if (!existsSync(providerRoot)) return []
  const found: { path: string; version: string }[] = []
  try {
    for (const platformDir of readdirSync(providerRoot, { withFileTypes: true })) {
      if (!platformDir.isDirectory()) continue
      const platformPath = join(providerRoot, platformDir.name)
      for (const versionEntry of readdirSync(platformPath, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) continue
        const versionPath = join(platformPath, versionEntry.name)
        for (const endpointEntry of readdirSync(versionPath, { withFileTypes: true })) {
          if (!endpointEntry.isDirectory()) continue
          const configPath = join(versionPath, endpointEntry.name, BUILTIN_FILENAME)
          if (existsSync(configPath)) found.push({ path: configPath, version: versionEntry.name })
        }
      }
    }
  } catch {
    // 目录读取失败（权限/竞态）不致命：降级到静态副本。
    return []
  }
  found.sort((a, b) => byVersionDesc(a.version, b.version))
  return found.map(entry => entry.path)
}

/** ZCode 用户数据目录根（各平台与凭据发现同源，见 auth-paths.ts）。 */
function zcodeHomeCandidates(platform: NodeJS.Platform = process.platform, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'darwin') {
    return [...new Set([
      join(home, '.zcode', 'v2'),
      join(home, 'Library', 'Application Support', 'zcode', 'v2'),
      join(home, 'Library', 'Application Support', '.zcode', 'v2'),
    ])]
  }
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local')
    const roamingAppData = env['APPDATA'] ?? join(home, 'AppData', 'Roaming')
    return [...new Set([
      join(home, '.zcode', 'v2'),
      join(localAppData, '.zcode', 'v2'),
      join(roamingAppData, '.zcode', 'v2'),
      join(localAppData, 'zcode', 'v2'),
      join(roamingAppData, 'zcode', 'v2'),
    ])]
  }
  if (platform === 'linux') {
    const linux = [
      join(home, '.zcode', 'v2'),
      join(home, '.config', 'zcode', 'v2'),
      join(home, '.config', '.zcode', 'v2'),
    ]
    if (!isWsl(platform, env)) return linux
    const wsl: string[] = []
    for (const userDir of findWslWindowsUserDirs(env)) {
      wsl.push(join(userDir, '.zcode', 'v2'), join(userDir, 'AppData', 'Roaming', '.zcode', 'v2'))
    }
    return [...new Set([...wsl, ...linux])]
  }
  return []
}

/** 平台相关的候选路径；`configuredPath` 是 Config 里的显式路径（最高优先级）。 */
export function builtinConfigCandidates(
  configuredPath?: string,
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = isWsl(),
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const fromConfig = configuredPath?.trim()
  if (fromConfig !== undefined && fromConfig !== '') return [fromConfig]
  const override = env[BUILTIN_CONFIG_ENV]
  if (override !== undefined && override.trim() !== '') {
    return [override]
  }
  // 运行时热更新缓存优先于安装目录静态副本：GLM-5.4 只在缓存 revision 48 里，
  // 静态副本（4.0.0 发版时 revision 44）没有它（实测 2026-11-23）。
  const runtime = zcodeHomeCandidates(platform, home, env).flatMap(dir => runtimeProviderCandidates(dir))
  const staticPaths: string[] = []
  if (platform === 'darwin') staticPaths.push(...darwinBuiltinConfigCandidates(home))
  if (platform === 'win32') staticPaths.push(...windowsBuiltinConfigCandidates(home, env))
  if (platform === 'linux') {
    staticPaths.push(...(wsl
      ? [...wslBuiltinConfigCandidates(env), ...linuxBuiltinConfigCandidates(home)]
      : linuxBuiltinConfigCandidates(home)))
  }
  return [...new Set([...runtime, ...staticPaths])]
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
 * `configuredPath` 来自 `Config.zcodeBuiltinConfig`（deployable 路径必须是
 * Config 字段，RULE-059）；空串/未设置时回落到环境变量与平台候选。
 *
 * 每次调用都重新读盘（约 180KB，调用方每小时至多一次）：客户端升级后名单
 * 无需重启插件即生效。任何读取/解析失败都静默降级——这里没有比「回退已
 * 注册名单」更正确的答案。
 */
export function readZcodeCodingPlanWhitelist(configuredPath?: string, home?: string): ReadonlySet<string> | undefined {
  for (const path of builtinConfigCandidates(configuredPath, process.platform, isWsl(), process.env, home)) {
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

/**
 * 用产品面白名单过滤一份模型名单。
 *
 * 用途是启动时的 saved 目录：它是上一次**成功拉取**的名单，可能由旧版本写入
 * （那时还没有白名单），因此可能含 Coding Plan 产品面之外的模型（实测 2026-10-08：
 * 升级用户的 saved 里躺着 11 个，而客户端只提供 2 个）。白名单不可得时原样返回
 * ——宁可按 saved 展示，也不要因为读不到客户端文件就把整组模型抹掉。
 *
 * 不过滤 Start Plan：它的名单语义是 entitlements 派生，另有链路（见 zcode-plan-models）。
 */
export function filterByCodingPlanWhitelist<T extends { id: string }>(
  models: readonly T[],
  whitelist: ReadonlySet<string> | undefined,
): readonly T[] {
  if (whitelist === undefined) return models
  return models.filter(model => whitelist.has(model.id.toLowerCase()))
}
