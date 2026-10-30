// scripts/lib/plugin-market-core.mjs — 插件市场索引与静态 npm registry 的纯逻辑层。
//
// 消费方：scripts/plugin-market.mjs（CLI：网络与磁盘 IO）与 test/plugin-market.test.ts。
// 本模块不做 IO、不安装也不执行任何包代码：输入是 GitHub Releases 元数据与 tarball 内的
// package.json，输出是确定性的站点文件内容映射（相对路径 → 文本）。规则来源：
// .workwork/market/brief.md 与官方索引格式 @deepseek-ai/dsh-plugin-market-index（format 1）。
//
// 站点布局（发行分支根的 market/ 目录，由 CI 生成；默认 alpha，收敛后 main）：
//   index.json                     格式 1 索引，用户把它当「索引源」添加
//   icons/<slug>.svg               索引里相对引用的图标
//   npm/<name>                     静态 npm registry 的 packument（scoped 名为嵌套目录）

import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { compareVersions, isStable, VERSION_RE } from './version-checks.mjs'

/** 默认 GitHub 仓库（owner/name）；CI 里由 GITHUB_REPOSITORY 覆盖。 */
export const DEFAULT_GITHUB_REPO = 'ShanWuYinShe/dsh-plugins'

/** 站点目录名：住在发行分支（alpha/main）根下，由 CI 生成，禁止手工编辑。 */
export const MARKET_DIR = 'market'

/** 默认引用名：站点随 alpha 适配线发布；收敛合入 main 后由 CI 按实际分支覆盖。 */
export const DEFAULT_MARKET_REF = 'alpha'

/** 索引整体的标题与说明（LocalizedText，必须含 en）。 */
export const MARKET_TITLE = Object.freeze({
  en: 'Chaoset DSH plugins',
  zh: 'Chaoset DSH 插件集',
})

/** 索引整体说明。 */
export const MARKET_DESCRIPTION = Object.freeze({
  en: 'Official plugin collection for DeepSeek Harness: desktop model access, provider quota, extra sandbox roots, and session archiving.',
  zh: 'DeepSeek Harness 官方插件集：桌面端模型接入、提供商额度显示、沙盒额外可写目录、归档会话管理。',
})

/** 索引声明的分类（id → LocalizedText）。 */
export const MARKET_CATEGORIES = Object.freeze({
  models: { title: { en: 'Models & providers', zh: '模型与提供商' } },
  sandbox: { title: { en: 'Sandbox', zh: '沙盒' } },
  sessions: { title: { en: 'Sessions', zh: '会话' } },
  interface: { title: { en: 'Interface', zh: '界面' } },
})

/** 索引声明的标签（id → LocalizedText）。 */
export const MARKET_LABELS = Object.freeze({
  'desktop-app': { title: { en: 'Desktop apps', zh: '桌面应用' } },
  cli: { title: { en: 'CLI', zh: '命令行' } },
  settings: { title: { en: 'Settings page', zh: '设置页' } },
  sidebar: { title: { en: 'Sidebar', zh: '侧边栏' } },
  composer: { title: { en: 'Composer dock', zh: '输入区底栏' } },
  filesystem: { title: { en: 'Filesystem', zh: '文件系统' } },
  remote: { title: { en: 'Remote services', zh: '远程服务' } },
})

/** 索引声明的排序键：order（手工指定展示顺序，升序）。 */
export const MARKET_SORT_KEYS = Object.freeze({
  order: { title: { en: 'Order', zh: '排序' }, order: 'asc' },
})

/** 发行分支根 market/ 目录的说明文件（CI 生成，因此内容固定）。 */
export const MARKET_README = [
  '# dsh-plugins 插件索引与静态 npm registry（自动生成）',
  '',
  '本目录由 CI 从 GitHub Releases 生成，**请勿手工编辑**；生成器、站点布局与校验方式见主仓',
  '`RELEASING.md` 的「插件索引与静态 registry」一节。',
  '',
  '当前随 alpha 适配线发布；收敛合入 main 后，索引源 URL 会随之换成 main 路径。',
  '',
  '- `index.json`：DSH「自定义插件索引」要添加的索引源',
  '- `icons/`：索引里相对引用的插件图标',
  '- `npm/`：静态 npm registry 的 packument（索引里每个版本的 `source.registry` 指向它）',
  '',
  '重新生成：推送任一 `<包目录>-v<版本>` tag（publish workflow 会在发布后自动生成并更新本目录），',
  '或在 Actions 里手动触发 publish workflow（workflow_dispatch，用于回填/修复）。',
  '',
].join('\n');

/**
 * 每个发布包的展示元数据。key 是 packages/ 下的目录名。
 * 新增发布包时必须同步补一项（build 会因为没有展示元数据而报错，不会静默漏收录）。
 * icon.background 与 icon.paths 一起渲染成确定性 SVG（不依赖外部图片）。
 */
export const PACKAGE_DISPLAY = Object.freeze({
  'dsh-any-connect': Object.freeze({
    slug: 'any-connect',
    title: { en: 'Any Connect', zh: 'Any Connect 模型接入' },
    description: {
      en: 'Bring models offered by desktop agents into DeepSeek Harness with zero configuration, per-model thinking effort, and billing rate at a glance.',
      zh: '把桌面端 Agent 提供的模型接入 DeepSeek Harness：零配置复用登录态、逐模型思考强度、模型选择器直接显示计费倍率。',
    },
    category: 'models',
    labels: ['desktop-app', 'cli', 'remote'],
    order: 1,
    icon: Object.freeze({
      background: '#4c6ef5',
      paths: Object.freeze([
        '<circle cx="24" cy="26" r="9" fill="none" stroke="#fff" stroke-width="4"/>',
        '<circle cx="41" cy="40" r="8" fill="none" stroke="#fff" stroke-width="4"/>',
        '<path d="M30 31l6 5" stroke="#fff" stroke-width="4" stroke-linecap="round"/>',
      ]),
    }),
  }),
  'provider-usage': Object.freeze({
    slug: 'provider-usage',
    title: { en: 'Provider Usage', zh: 'Provider Usage 额度显示' },
    description: {
      en: 'Show the current LLM provider remaining quota in the composer dock, with a generic querier registry any provider plugin can extend.',
      zh: '在对话输入区底栏显示当前提供商的剩余额度，并带一个任何 provider 插件都能扩展的通用查询器注册表。',
    },
    category: 'interface',
    labels: ['composer', 'remote'],
    order: 2,
    icon: Object.freeze({
      background: '#12a150',
      paths: Object.freeze([
        '<path d="M16 42a16 16 0 0132 0" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>',
        '<path d="M32 42l8-12" stroke="#fff" stroke-width="4" stroke-linecap="round"/>',
        '<circle cx="32" cy="42" r="3.5" fill="#fff"/>',
      ]),
    }),
  }),
  'sandbox-extra-roots': Object.freeze({
    slug: 'sandbox-extra-roots',
    title: { en: 'Sandbox Extra Roots', zh: '沙盒额外允许写入目录' },
    description: {
      en: 'Extra writable roots for the workspace-write sandbox across Seatbelt, bwrap and Landlock profiles, plus the filesystem fence.',
      zh: '为 workspace-write 沙盒增加额外可写目录：同时覆盖 Seatbelt / bwrap / Landlock 与文件系统围栏，并带设置页。',
    },
    category: 'sandbox',
    labels: ['settings', 'filesystem'],
    order: 3,
    icon: Object.freeze({
      background: '#e8890c',
      paths: Object.freeze([
        '<path d="M32 15l15 6v10c0 10-6 16-15 20-9-4-15-10-15-20V21z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>',
        '<path d="M25 32l5 5 9-9" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>',
      ]),
    }),
  }),
  'session-archive': Object.freeze({
    slug: 'session-archive',
    title: { en: 'Session Archive', zh: '归档会话管理' },
    description: {
      en: 'Browse archived sessions, inspect their content, and batch restore or permanently delete them from the sidebar.',
      zh: '浏览归档会话、查看会话内容，并从侧边栏批量恢复或彻底删除。',
    },
    category: 'sessions',
    labels: ['sidebar', 'remote'],
    order: 4,
    icon: Object.freeze({
      background: '#7c5cfc',
      paths: Object.freeze([
        '<rect x="15" y="19" width="34" height="9" rx="2" fill="none" stroke="#fff" stroke-width="4"/>',
        '<path d="M19 28v15a3 3 0 003 3h20a3 3 0 003-3V28" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>',
        '<path d="M27 35h10" stroke="#fff" stroke-width="4" stroke-linecap="round"/>',
      ]),
    }),
  }),
})

/** 生成器输入错误（releases 元数据 / tarball / 站点内容不合法）：消息面向使用者。 */
export class MarketInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MarketInputError'
  }
}

/**
 * 站点原始内容根 URL（发行分支根下的 market/ 目录）。
 * 默认 ref=alpha：站点随 alpha 适配线发布；收敛合入 main 后 CI 会用 main 覆盖。
 * @param repo - owner/name。
 * @param ref - 发行分支/引用名（CI 里由 tag 所属分支推导）。
 * @returns raw.githubusercontent 上的站点根（无尾斜杠）。
 * @throws {MarketInputError} ref 为空或含空白/查询串等非法字符。
 */
export function rawMarketBaseUrl(repo = DEFAULT_GITHUB_REPO, ref = DEFAULT_MARKET_REF) {
  if (typeof ref !== 'string' || ref.trim() === '' || /[\s?#]/.test(ref)) {
    throw new MarketInputError('站点 ref 不合法: ' + JSON.stringify(ref))
  }
  return 'https://raw.githubusercontent.com/' + repo + '/' + ref + '/' + MARKET_DIR
}

/**
 * 索引源 URL（用户添加到「发现 → 添加索引源」的那个地址）。
 * @param repo - owner/name。
 * @returns 索引文件的绝对 URL。
 */
export function defaultIndexUrl(repo = DEFAULT_GITHUB_REPO, ref = DEFAULT_MARKET_REF) {
  return rawMarketBaseUrl(repo, ref) + '/index.json'
}

/**
 * 静态 npm registry 根 URL（索引里每个版本的 source.registry）。
 * @param repo - owner/name。
 * @returns 以斜杠结尾的 registry URL：pnpm 会把编码后的包名直接拼在后面。
 */
export function defaultRegistryUrl(repo = DEFAULT_GITHUB_REPO, ref = DEFAULT_MARKET_REF) {
  return rawMarketBaseUrl(repo, ref) + '/npm/'
}

/**
 * 规范化 registry URL：必须是 http(s) 绝对 URL，且以斜杠结尾。
 * @param value - 传入的 registry URL。
 * @returns 规范化后的 URL。
 * @throws {MarketInputError} 非法 URL。
 */
export function normalizeRegistryUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new MarketInputError('registry URL 不是绝对 URL: ' + JSON.stringify(value))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MarketInputError('registry URL 必须是 http(s): ' + JSON.stringify(value))
  }
  if (url.search !== '' || url.hash !== '') {
    throw new MarketInputError('registry URL 不能带查询串或片段: ' + JSON.stringify(value))
  }
  if (url.username !== '' || url.password !== '') {
    throw new MarketInputError('registry URL 不能带用户名密码（会被写进索引）: ' + JSON.stringify(value))
  }
  const href = url.href.endsWith('/') ? url.href : url.href + '/'
  return href
}

/**
 * 发布 tag 名：<目录>-v<版本>（与 publish.yml / publish-gate 的约定一致）。
 * @param dir - packages/ 下的目录名。
 * @param version - 精确 SemVer。
 * @returns tag 名。
 */
export function releaseTagFor(dir, version) {
  return dir + '-v' + version
}

/**
 * Release 资产文件名：chaoset-<目录>-<版本>.tgz（bun pm pack 的产物名）。
 * @param dir - packages/ 下的目录名。
 * @param version - 精确 SemVer。
 * @returns 资产文件名。
 */
export function assetNameFor(dir, version) {
  return 'chaoset-' + dir + '-' + version + '.tgz'
}

/**
 * 解析发布 tag；不是本仓发布形态时返回 undefined。
 * @param tag - git tag 名。
 * @param dirs - 已知的包目录名集合。
 * @returns { dir, version } 或 undefined。
 */
export function parseReleaseTag(tag, dirs) {
  if (typeof tag !== 'string') return undefined
  for (const dir of dirs) {
    const prefix = dir + '-v'
    if (!tag.startsWith(prefix)) continue
    const version = tag.slice(prefix.length)
    if (!VERSION_RE.test(version)) return undefined
    return { dir, version }
  }
  return undefined
}

/**
 * 从声明的 engines.dsh（或旧字段 dsh.host）求出「精确宿主版本 pin」：
 *  - 已是精确 SemVer（如 0.2.2-alpha.2）→ 原样；
 *  - 常见范围形态（^X / ~X / >=X / ">=X <Y"）→ 取最低满足版本 X
 *    （发布时实际适配的宿主版本；历史 tarball 全是 ^X）；
 *  - 其余（* / latest / || 组合 / 非字符串等）→ undefined，调用方 fail-safe 跳过。
 * @param {unknown} declared - 清单里的原始声明值。
 * @returns {string|undefined} 精确 pin。
 */
export function exactPinOfDeclared(declared) {
  if (typeof declared !== 'string') return undefined
  const declaredText = declared.trim()
  if (declaredText === '') return undefined
  if (VERSION_RE.test(declaredText)) return declaredText
  const patterns = [
    /^\^([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/,
    /^~([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/,
    /^>=([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/,
    /^>=\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\s+<[^ ]+$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(declaredText)
    if (match !== null) return match[1]
  }
  return undefined
}

/**
 * tarball 清单里会进入「运行期依赖」的字段。
 * 外部插件的运行期依赖必须为空（只放 devDependencies）：DSH 安装索引版本时执行
 * pnpm add <spec> --registry=<静态 registry>，pnpm 会按 tarball 自带的 package.json 去静态
 * registry 解析 dependencies/optionalDependencies 并 404；运行期依赖由宿主 profile runner 的
 * runtime resolution 供给（官方外部插件机制）。排除本仓自身 @chaoset 包的内部互引。
 */
const RUNTIME_DEPENDENCY_SECTIONS = ['dependencies', 'optionalDependencies']
/** 本仓插件包作用域：内部互引不算外部运行期依赖。 */
const OWN_PACKAGE_SCOPE = '@chaoset/'

/**
 * 运行期依赖策略的生效时刻（ISO 8601，含时区）。该时刻**之后发布**的插件版本必须运行期零依赖
 * （`dependencies`/`optionalDependencies` 为空，宿主依赖只放 `devDependencies`，运行期由宿主
 * runtime resolution 供给）；该时刻**之前**发布的 tarball 不可变，只告警。
 *
 * 按发布时间而不是「最新版本」判定，是为了不让索引侧校验依赖发布顺序：策略生效前的历史 latest
 * 带运行期依赖时仍能重新生成站点，等新的零依赖版本发布后自然落入阻断范围。
 */
export const RUNTIME_DEPENDENCY_POLICY_SINCE = '2026-10-30T00:00:00Z'
/** RUNTIME_DEPENDENCY_POLICY_SINCE 的 Unix 秒（策略判定用；必须是合法整数时刻）。 */
const RUNTIME_DEPENDENCY_POLICY_SINCE_EPOCH = Math.floor(Date.parse(RUNTIME_DEPENDENCY_POLICY_SINCE) / 1000)
if (!Number.isInteger(RUNTIME_DEPENDENCY_POLICY_SINCE_EPOCH)) {
  throw new Error('RUNTIME_DEPENDENCY_POLICY_SINCE 不是合法的 ISO 时刻: ' + JSON.stringify(RUNTIME_DEPENDENCY_POLICY_SINCE))
}

/** Unix 秒 → ISO 8601（整秒；告警/错误文案用）。 */
function isoSecondsOf(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.000Z$/, 'Z')
}

/** 发布时间是否不早于运行期依赖策略生效时刻（时间缺失/非法视为不阻断，只告警）。 */
function isRuntimeDependencyBlocking(publishTimestamp) {
  return Number.isInteger(publishTimestamp) && publishTimestamp >= RUNTIME_DEPENDENCY_POLICY_SINCE_EPOCH
}

/** 名 → 值的普通对象：键排序，保证序列化确定性。 */
function sortedRecord(record) {
  const result = {}
  for (const key of Object.keys(record).sort()) result[key] = record[key]
  return result
}

/**
 * 扫描一个 tarball 内 package.json 的运行期依赖声明（dependencies + optionalDependencies，
 * 排除 @chaoset 自身包）。只读取声明，不解析版本范围。
 * @param manifest - tarball 内的 package.json。
 * @returns 名 → 范围（键排序）；不是对象或声明非法时为空对象。
 */
export function runtimeDependenciesOf(manifest) {
  const result = {}
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return result
  for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
    const declared = manifest[section]
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) continue
    for (const [name, range] of Object.entries(declared)) {
      if (typeof name !== 'string' || name === '' || name.startsWith(OWN_PACKAGE_SCOPE)) continue
      if (typeof range !== 'string' || range.trim() === '') continue
      if (!Object.hasOwn(result, name)) result[name] = range
    }
  }
  return sortedRecord(result)
}

/**
 * 汇总「运行期依赖」事实，供 build/plan 的 stderr 与 summary 呈报。
 * 按 RUNTIME_DEPENDENCY_POLICY_SINCE 分类：发布时间不早于策略生效时刻 → blocking（check/build
 * 会失败）；更早或时间缺失 → legacy（历史 tarball 不可变，仅告警）。输出顺序即入参顺序（确定性）。
 * @param rows - { name, version, publishedAt, dependencies } 数组（插件展示顺序 × 版本降序）；
 *   publishedAt 是 Release 发布时间（Unix 秒）。
 * @returns { policySince, blocking, legacy }。
 */
export function runtimeDependencySummary(rows) {
  const blocking = []
  const legacy = []
  for (const row of rows) {
    const dependencies = sortedRecord(row.dependencies === undefined ? {} : row.dependencies)
    if (Object.keys(dependencies).length === 0) continue
    const publishedAt = Number.isInteger(row.publishedAt) ? row.publishedAt : -1
    const record = { name: row.name, version: row.version, publishedAt, dependencies }
    if (isRuntimeDependencyBlocking(publishedAt)) blocking.push(record)
    else legacy.push(record)
  }
  return { policySince: RUNTIME_DEPENDENCY_POLICY_SINCE, blocking, legacy }
}

/**
 * 从 GitHub Releases API 记录里收集候选版本（只做元数据筛选，不读 tarball）。
 *
 * 过滤：非 draft；tag 形如 <目录>-v<精确 SemVer>；published_at 可解析；资产存在
 * （优先精确的 chaoset-<目录>-<版本>.tgz，只有单个 .tgz 时按它兜底）。
 * 同一版本重复出现时保留 publishedAt 较新的一条（其余记为 duplicate-version）。
 * 输出顺序确定：按展示 order，再按版本降序。
 * @param releases - GitHub Releases API 数组。
 * @param options - { dirs?: 包目录名数组 }。
 * @returns { candidates, skipped }；skipped 每项 { tag, reason }。
 */
export function collectCandidates(releases, options = {}) {
  const dirs = options.dirs === undefined ? Object.keys(PACKAGE_DISPLAY) : options.dirs
  const dirSet = new Set(dirs)
  const candidates = []
  const skipped = []
  const byVersion = new Map()
  if (!Array.isArray(releases)) throw new MarketInputError('releases 必须是数组')
  for (const release of releases) {
    if (release === null || typeof release !== 'object') {
      skipped.push({ tag: '(invalid release)', reason: 'invalid-release' })
      continue
    }
    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    const parsed = parseReleaseTag(tag, dirs)
    if (parsed === undefined) continue
    if (!dirSet.has(parsed.dir)) continue
    if (release.draft === true) {
      skipped.push({ tag, reason: 'draft' })
      continue
    }
    const published = typeof release.published_at === 'string' ? Date.parse(release.published_at) : Number.NaN
    if (!Number.isFinite(published)) {
      skipped.push({ tag, reason: 'missing-published-at' })
      continue
    }
    const assets = Array.isArray(release.assets) ? release.assets.filter(asset => asset !== null && typeof asset === 'object') : []
    const tgzAssets = assets.filter(asset => typeof asset.name === 'string' && asset.name.endsWith('.tgz'))
    const expectedName = assetNameFor(parsed.dir, parsed.version)
    let asset = tgzAssets.find(candidate => candidate.name === expectedName)
    let fallbackAsset = false
    if (asset === undefined && tgzAssets.length === 1) {
      asset = tgzAssets[0]
      fallbackAsset = true
    }
    if (asset === undefined) {
      skipped.push({ tag, reason: tgzAssets.length === 0 ? 'asset-missing' : 'asset-name-mismatch' })
      continue
    }
    if (typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith('https://')) {
      skipped.push({ tag, reason: 'asset-url-invalid' })
      continue
    }
    const candidate = {
      dir: parsed.dir,
      version: parsed.version,
      tag,
      publishedAt: Math.floor(published / 1000),
      asset: {
        name: asset.name,
        size: typeof asset.size === 'number' ? asset.size : 0,
        id: typeof asset.id === 'number' ? asset.id : undefined,
        browserDownloadUrl: asset.browser_download_url,
      },
      fallbackAsset,
      prerelease: release.prerelease === true,
    }
    const key = parsed.dir + '@' + parsed.version
    const existing = byVersion.get(key)
    if (existing === undefined) {
      byVersion.set(key, candidate)
      continue
    }
    if (candidate.publishedAt > existing.publishedAt) {
      byVersion.set(key, candidate)
      skipped.push({ tag: existing.tag, reason: 'duplicate-version' })
    } else {
      skipped.push({ tag, reason: 'duplicate-version' })
    }
  }
  for (const candidate of byVersion.values()) candidates.push(candidate)
  const orderOf = dir => {
    const display = PACKAGE_DISPLAY[dir]
    return display === undefined ? Number.MAX_SAFE_INTEGER : display.order
  }
  candidates.sort((left, right) => orderOf(left.dir) - orderOf(right.dir) || compareVersions(right.version, left.version))
  return { candidates, skipped }
}

/**
 * 判断一个 tarball 内 package.json 是否应被收录，并给出该版本要声明的 engines.dsh。
 * 收录条件（brief 六）：包名与包目录对应、版本与 tag 一致、dsh.bundle 存在，且：
 *  1. 声明了精确 engines.dsh → 原样使用；
 *  2. 声明了范围形态（历史版本全是 ^X）→ 取最低满足版本作为精确 pin（见 exactPinOfDeclared），
 *     无法判定则 fail-safe 跳过（invalid-engines-dsh）；
 *  3. 没有 engines.dsh 但旧字段 dsh.host 是精确版本 → 原样使用；非精确则跳过（invalid-dsh-host-pin）；
 *  4. 两者都没有 → 跳过（missing-engines-dsh）。
 * 另外扫描运行期依赖（见 runtimeDependenciesOf）：外部插件它必须为空，check 对每个插件的
 * 最高版本仍带运行期依赖会失败；历史版本只在 build/check 里告警（tarball 不可变）。
 * @param manifest - tarball 内 package.json 解析结果。
 * @param candidate - collectCandidates 的条目。
 * @param expectedName - 该目录对应的 npm 包名。
 * @returns { eligible: true, enginesDsh, rangeSource, runtimeDependencies } 或 { eligible: false, reason }。
 */
export function inspectManifest(manifest, candidate, expectedName) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { eligible: false, reason: 'manifest-not-object' }
  }
  if (manifest.name !== expectedName) {
    return { eligible: false, reason: 'name-mismatch: expected ' + expectedName + ', got ' + String(manifest.name) }
  }
  if (manifest.version !== candidate.version) {
    return { eligible: false, reason: 'version-mismatch: tag ' + candidate.version + ', manifest ' + String(manifest.version) }
  }
  const dsh = manifest.dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh) || dsh.bundle === null || typeof dsh.bundle !== 'object') {
    return { eligible: false, reason: 'missing-dsh-bundle' }
  }
  const engines = manifest.engines
  const declared = engines !== null && typeof engines === 'object' && typeof engines.dsh === 'string' ? engines.dsh : undefined
  const runtimeDependencies = runtimeDependenciesOf(manifest)
  if (declared !== undefined) {
    const pin = exactPinOfDeclared(declared)
    if (pin === undefined) return { eligible: false, reason: 'invalid-engines-dsh: ' + JSON.stringify(declared) }
    if (pin === declared.trim()) return { eligible: true, enginesDsh: pin, rangeSource: 'exact', runtimeDependencies }
    return { eligible: true, enginesDsh: pin, rangeSource: 'floor', declaredEnginesDsh: declared, runtimeDependencies }
  }
  if (Object.hasOwn(dsh, 'host')) {
    // 旧字段 dsh.host 只接受精确版本 pin（brief：旧 dsh.host 精确 pin → 原样；范围/非法跳过）。
    const host = typeof dsh.host === 'string' ? dsh.host.trim() : undefined
    if (host === undefined || !VERSION_RE.test(host)) {
      return { eligible: false, reason: 'invalid-dsh-host-pin: ' + JSON.stringify(dsh.host) }
    }
    return { eligible: true, enginesDsh: host, rangeSource: 'dsh-host', runtimeDependencies }
  }
  return { eligible: false, reason: 'missing-engines-dsh' }
}

/**
 * 从 npm tarball（gzip 压缩的 ustar）里读取 package/package.json，不安装、不执行任何代码。
 * @param bytes - tarball 原始字节。
 * @returns 解析后的 package.json 对象。
 * @throws {MarketInputError} gzip/tar/JSON 不合法或缺少 package/package.json。
 */
export function readPackageJsonFromTarball(bytes) {
  let archive
  try {
    archive = gunzipSync(bytes)
  } catch (error) {
    throw new MarketInputError('tarball 不是有效的 gzip：' + String(error && error.message ? error.message : error))
  }
  let entries
  try {
    entries = readTarEntries(archive)
  } catch (error) {
    if (error instanceof MarketInputError) throw error
    throw new MarketInputError('tarball 不是有效的 tar：' + String(error && error.message ? error.message : error))
  }
  const entry = entries.find(item => item.name === 'package/package.json')
  if (entry === undefined) throw new MarketInputError('tarball 内缺少 package/package.json')
  let manifest
  try {
    manifest = JSON.parse(entry.data.toString('utf8'))
  } catch {
    throw new MarketInputError('tarball 内的 package/package.json 不是合法 JSON')
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new MarketInputError('tarball 内的 package/package.json 不是对象')
  }
  return manifest
}

/**
 * 读取 tar 条目（ustar + pax + GNU longname），只返回常规文件。
 * @param buffer - 解压后的 tar 字节。
 * @returns { name, data } 数组。
 */
function readTarEntries(buffer) {
  const entries = []
  let offset = 0
  let pendingPath
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (isZeroBlock(header)) {
      offset += 512
      const next = buffer.subarray(offset, offset + 512)
      if (next.length === 0 || isZeroBlock(next)) break
      continue
    }
    if (header.subarray(257, 262).toString('utf8') !== 'ustar') {
      throw new MarketInputError('tar 条目缺少 ustar 标识（偏移 ' + String(offset) + '）')
    }
    const rawName = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = readOctal(header, 124, 12)
    const type = String.fromCharCode(header[156])
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) throw new MarketInputError('tar 条目长度超出文件末尾')
    const data = buffer.subarray(dataStart, dataEnd)
    const name = pendingPath === undefined ? (prefix === '' ? rawName : prefix + '/' + rawName) : pendingPath
    pendingPath = undefined
    if (type === 'x' || type === 'g') {
      const parsed = parsePaxPath(data.toString('utf8'))
      if (parsed !== undefined) pendingPath = parsed
    } else if (type === 'L') {
      pendingPath = data.toString('utf8').replace(/\0.*$/, '')
    } else if (type === '0' || type === '\0') {
      entries.push({ name, data })
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

/** pax 扩展头的 path 值；没有则 undefined。 */
function parsePaxPath(text) {
  let rest = text
  while (rest !== '') {
    const space = rest.indexOf(' ')
    if (space === -1) return undefined
    const length = Number(rest.slice(0, space))
    if (!Number.isInteger(length) || length <= space + 1) return undefined
    const record = rest.slice(space + 1, length - 1)
    rest = rest.slice(length)
    const eq = record.indexOf('=')
    if (eq === -1) continue
    if (record.slice(0, eq) === 'path') return record.slice(eq + 1)
  }
  return undefined
}

/** tar 头是否全零块。 */
function isZeroBlock(block) {
  for (let index = 0; index < block.length; index += 1) {
    if (block[index] !== 0) return false
  }
  return true
}

/** 以 NUL 结尾的定长字符串字段。 */
function readString(header, offset, length) {
  const field = header.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

/** 八进制数字字段（允许前后空格与 NUL）。 */
function readOctal(header, offset, length) {
  const text = readString(header, offset, length).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new MarketInputError('tar 头里的长度为非八进制: ' + JSON.stringify(text))
  return Number.parseInt(text, 8)
}

/**
 * npm tarball 的 sha512 integrity（SRI 形态：sha512-<base64>）。
 * @param bytes - tarball 字节。
 * @returns SRI 字符串。
 */
export function computeIntegrity(bytes) {
  return 'sha512-' + createHash('sha512').update(bytes).digest('base64')
}

/**
 * npm tarball 的 sha1 shasum（40 位小写十六进制）。
 * @param bytes - tarball 字节。
 * @returns sha1 十六进制字符串。
 */
export function computeShasum(bytes) {
  return createHash('sha1').update(bytes).digest('hex')
}

/** JSON 规范化：两空格缩进 + 结尾换行（站点内所有 JSON 的唯一序列化方式）。 */
export function serializeJson(value) {
  return JSON.stringify(value, null, 2) + '\n'
}

/** 文本的 sha256 十六进制。 */
export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 站点摘要：按相对路径排序，逐文件哈希后聚合（与写入顺序、文件系统枚举顺序无关）。
 * @param files - Map<相对路径, 文本>。
 * @returns 'sha256:<hex>'。
 */
export function siteDigest(files) {
  const paths = [...files.keys()].sort()
  const lines = []
  for (const path of paths) lines.push(path + '\n' + sha256Hex(files.get(path)) + '\n')
  return 'sha256:' + sha256Hex(lines.join(''))
}

/** 包名 → packument 的站点相对路径（scoped 名是嵌套目录，pnpm 用 %2F 请求）。 */
export function packumentPath(name) {
  return 'npm/' + name
}

/**
 * 组装站点：把候选版本 + tarball 内 package.json 变成 index.json / icons / packument。
 *
 * 只收录 inspectManifest 判定 eligible 的版本；不满足的进 summary.skipped（带原因）。
 * 输出对同一输入完全确定（不含时间戳、无随机与枚举顺序依赖）。
 * 运行期依赖事实（见 runtimeDependenciesOf）汇总进 summary.runtimeDependencies：
 * 每个插件最高版本仍带运行期依赖时进 latest（check/build 会失败），历史版本进 historical（告警）。
 * @param input - { repo, baseUrl, registryUrl, candidates, manifests, expectedNames }
 *   manifests 是 Map<candidate.tag, package.json>；缺失的候选按 missing-manifest 跳过。
 * @returns { files: Map<相对路径,文本>, summary: { plugins, versionCount, rangeSources, skipped,
 *   runtimeDependencies, digest } }
 */
export function buildSite(input) {
  const repo = input.repo === undefined ? DEFAULT_GITHUB_REPO : input.repo
  const baseUrl = trimTrailingSlash(input.baseUrl === undefined ? rawMarketBaseUrl(repo) : input.baseUrl)
  const registryUrl = normalizeRegistryUrl(input.registryUrl === undefined ? defaultRegistryUrl(repo) : input.registryUrl)
  const candidates = input.candidates === undefined ? [] : input.candidates
  const manifests = input.manifests === undefined ? new Map() : input.manifests
  const expectedNames = input.expectedNames === undefined ? expectedNamesFromDisplay() : input.expectedNames
  const skipped = []
  const byDir = new Map()
  for (const candidate of candidates) {
    const expectedName = expectedNames[candidate.dir]
    if (expectedName === undefined) {
      skipped.push({ tag: candidate.tag, reason: 'unknown-package-dir' })
      continue
    }
    const manifest = manifests.get(candidate.tag)
    if (manifest === undefined) {
      skipped.push({ tag: candidate.tag, reason: 'missing-manifest' })
      continue
    }
    const inspection = inspectManifest(manifest, candidate, expectedName)
    if (!inspection.eligible) {
      skipped.push({ tag: candidate.tag, reason: inspection.reason })
      continue
    }
    const entry = {
      candidate,
      manifest,
      enginesDsh: inspection.enginesDsh,
      rangeSource: inspection.rangeSource,
      declaredEnginesDsh: inspection.declaredEnginesDsh,
      runtimeDependencies: inspection.runtimeDependencies,
    }
    const versions = byDir.get(candidate.dir)
    if (versions === undefined) byDir.set(candidate.dir, [entry])
    else versions.push(entry)
  }
  const orderedDirs = Object.keys(PACKAGE_DISPLAY).filter(dir => byDir.has(dir))
  const plugins = []
  const files = new Map()
  /** 运行期依赖呈报行：插件展示顺序 × 版本降序。 */
  const runtimeDependencyRows = []
  for (const dir of orderedDirs) {
    const display = PACKAGE_DISPLAY[dir]
    const entries = byDir.get(dir)
    entries.sort((left, right) => compareVersions(right.candidate.version, left.candidate.version))
    for (const entry of entries) {
      runtimeDependencyRows.push({
        name: expectedNames[dir],
        version: entry.candidate.version,
        publishedAt: entry.candidate.publishedAt,
        dependencies: entry.runtimeDependencies,
      })
    }
    const versions = entries.map(entry => ({
      version: entry.candidate.version,
      publishTimestamp: entry.candidate.publishedAt,
      source: { type: 'npm', registry: registryUrl },
      engines: { dsh: entry.enginesDsh },
    }))
    const iconPath = 'icons/' + display.slug + '.svg'
    files.set(iconPath, renderIcon(display))
    plugins.push({
      name: expectedNames[dir],
      title: display.title,
      description: display.description,
      icon: iconPath,
      author: 'chaoset',
      homepage: requireHomepage(entries[0].manifest.homepage),
      repository: requireRepository(entries[0].manifest),
      metadata: {
        category: display.category,
        // 索引级元数据统一取最高版本（与 description/license/homepage/repository 一致）。
        keywords: keywordsOf(entries[0].manifest),
        labels: display.labels.slice(),
        sortKeys: { order: display.order },
      },
      versions,
    })
    files.set(packumentPath(expectedNames[dir]), serializeJson(packumentOf(dir, expectedNames[dir], entries, registryUrl)))
  }
  const index = {
    format: 1,
    title: MARKET_TITLE,
    description: MARKET_DESCRIPTION,
    metadata: {
      categories: MARKET_CATEGORIES,
      labels: MARKET_LABELS,
      sortKeys: MARKET_SORT_KEYS,
    },
    plugins,
  }
  files.set('index.json', serializeJson(index))
  files.set('README.md', MARKET_README)
  const versionCount = plugins.reduce((total, plugin) => total + plugin.versions.length, 0)
  const rangeSources = { exact: 0, floor: 0, 'dsh-host': 0 }
  for (const entries of byDir.values()) for (const entry of entries) rangeSources[entry.rangeSource] += 1
  return {
    files,
    summary: {
      repo,
      baseUrl,
      registryUrl,
      plugins: plugins.map(plugin => ({ name: plugin.name, versions: plugin.versions.map(version => version.version) })),
      versionCount,
      rangeSources,
      runtimeDependencies: runtimeDependencySummary(runtimeDependencyRows),
      skipped,
      digest: siteDigest(files),
    },
  }
}

/** build 用：从展示元数据推出 dir → 包名（测试/无仓库信息时用）。 */
export function expectedNamesFromDisplay() {
  const names = {}
  for (const [dir, display] of Object.entries(PACKAGE_DISPLAY)) names[dir] = '@chaoset/' + dir
  return names
}

/** 组 packument：每个版本的安装元数据 + dist（tarball URL / integrity / shasum）。 */
function packumentOf(dir, name, entries, registryUrl) {
  const versions = {}
  const time = {}
  let latestStable
  let latestAny
  for (const entry of entries) {
    const manifest = entry.manifest
    const version = entry.candidate.version
    versions[version] = packumentVersion(entry, registryUrl)
    time[version] = new Date(entry.candidate.publishedAt * 1000).toISOString()
    if (latestAny === undefined || compareVersions(version, latestAny) > 0) latestAny = version
    if (isStable(version) && (latestStable === undefined || compareVersions(version, latestStable) > 0)) latestStable = version
  }
  return {
    name,
    description: entryDescription(entries),
    license: entryLicense(entries),
    homepage: requireHomepage(entries[0].manifest.homepage),
    'dist-tags': { latest: latestStable === undefined ? latestAny : latestStable },
    versions,
    time,
  }
}

/** 组单版本 packument 记录（字段顺序固定，保证确定性）。 */
function packumentVersion(entry, registryUrl) {
  const manifest = entry.manifest
  // dshMarket 是本站点自有的来源记录（npm 客户端忽略未知字段），check 据此离线复核：
  //  - 范围取整版本保留原声明，验算精确 pin；
  //  - 声明了运行期依赖的版本保留依赖清单，供 check 判定「最新版本必须零运行期依赖」。
  const provenance = {}
  if (entry.rangeSource === 'floor') {
    provenance.source = 'engines-range'
    provenance.declaredEnginesDsh = entry.declaredEnginesDsh
  }
  const runtimeDependencies = entry.runtimeDependencies === undefined ? {} : entry.runtimeDependencies
  if (Object.keys(runtimeDependencies).length > 0) provenance.runtimeDependencies = sortedRecord(runtimeDependencies)
  const record = {
    name: manifest.name,
    version: manifest.version,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    license: typeof manifest.license === 'string' ? manifest.license : undefined,
    // 生效 engines.dsh 永远是单个精确宿主版本：新清单原样、历史范围清单取下界、
    // 旧 dsh.host 精确 pin 原样。DSH 安装/启动按精确匹配严格判定（宿主升级需重新发布）。
    engines: { ...(manifest.engines === null || typeof manifest.engines !== 'object' ? {} : manifest.engines), dsh: entry.enginesDsh },
    homepage: requireHomepage(manifest.homepage),
    repository: requireRepository(manifest),
    keywords: keywordsOf(manifest),
    // 刻意不写 dependencies / optionalDependencies / peerDependencies：
    // DSH 安装索引版本时执行 pnpm add <spec> --registry=<静态 registry>，--registry 作用于
    // 整条命令——一旦 packument 声明了宿主依赖（zod、@deepseek-ai/node-addon-system 等），
    // pnpm 会去静态 registry 找它们的 packument 并 404。这些依赖本来由宿主 profile runner
    // 的 runtime resolution 从宿主安装闭包补齐（官方外部插件机制），因此不在这里声明。
    // 反向校验见 validateSite：packument 版本记录出现依赖段即报错。
    bin: manifest.bin,
    dsh: manifest.dsh,
    // 来源记录（映射声明 / 运行期依赖清单）保留供离线复核；两者都没有时不写。
    ...Object.keys(provenance).length > 0 ? { dshMarket: provenance } : {},
    dist: {
      tarball: entry.candidate.asset.browserDownloadUrl,
      integrity: requireDigest(entry.candidate, 'integrity'),
      shasum: requireDigest(entry.candidate, 'shasum'),
    },
  }
  return record
}

/** 候选版本必须由 IO 层附上 tarball 摘要；缺失即输入不完整。 */
function requireDigest(candidate, field) {
  const value = candidate[field]
  if (typeof value !== 'string' || value === '') {
    throw new MarketInputError('候选版本 ' + candidate.tag + ' 缺少 tarball ' + field + '（下载阶段计算）')
  }
  return value
}

/** 取最高版本（entries 已按版本降序）的 description。 */
function entryDescription(entries) {
  const manifest = entries[0].manifest
  return typeof manifest.description === 'string' ? manifest.description : undefined
}

/** 取最高版本的 license。 */
function entryLicense(entries) {
  const manifest = entries[0].manifest
  return typeof manifest.license === 'string' ? manifest.license : undefined
}

/** package.json#keywords → 字符串数组（缺失/形态不对时为空数组）。 */
function keywordsOf(manifest) {
  if (!Array.isArray(manifest.keywords)) return []
  return manifest.keywords.filter(keyword => typeof keyword === 'string')
}

/**
 * package.json#homepage → 索引里的 homepage。官方 `homepageUrl` 规则：必须是 http(s) 绝对 URL
 * （查询串/片段可以保留，npm 的 homepage 常带 #readme）。声明了却非法时 fail-fast：
 * 写进索引会被官方 parseMarketIndex 拒绝，build 自校验会失败，不如在生成处报清楚。
 * @param value - 清单里的 homepage。
 * @returns 原始 URL 文本；未声明/空串 → undefined。
 * @throws {MarketInputError} 声明了但不是 http(s) 绝对 URL、或带凭据。
 */
function requireHomepage(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new MarketInputError('package.json homepage 必须是字符串: ' + JSON.stringify(value))
  const text = value.trim()
  if (text === '') return undefined
  let url
  try {
    url = new URL(text)
  } catch {
    throw new MarketInputError('package.json homepage 不是绝对 URL: ' + JSON.stringify(value))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new MarketInputError('package.json homepage 必须是 http(s)（官方索引规则）: ' + JSON.stringify(value))
  }
  if (url.username !== '' || url.password !== '') {
    throw new MarketInputError('package.json homepage 不能带凭据: ' + JSON.stringify(value))
  }
  return text
}

/** 官方 `packagePath` 规则：URL 安全路径段。 */
const REPOSITORY_PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/

/**
 * package.json#repository.directory → 索引里的 repository.directory。
 * 官方 `packagePath` 规则：相对 POSIX 目录，分段只能是 [A-Za-z0-9._@+-] 且不能是 . / ..。
 * @param value - 清单里的 repository.directory。
 * @returns 去掉开头 ./ 的相对目录；未声明/空串 → undefined。
 * @throws {MarketInputError} 声明了但不是合法相对目录。
 */
function requireRepositoryDirectory(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new MarketInputError('package.json repository.directory 必须是字符串: ' + JSON.stringify(value))
  const text = value.replace(/^\.\//, '')
  if (text === '') return undefined
  for (const segment of text.split('/')) {
    if (segment === '.' || segment === '..' || !REPOSITORY_PATH_SEGMENT.test(segment)) {
      throw new MarketInputError('package.json repository.directory 必须是合法相对目录（官方 packagePath 规则）: ' + JSON.stringify(value))
    }
  }
  return text
}

/**
 * package.json#repository → 索引里的 repository。官方 `repository` 规则：url 必须是 http(s)
 * 绝对 URL、不含凭据/查询串/片段；directory 走 packagePath 规则。仓库地址去掉 git+ 前缀与
 * .git 后缀（展示用，写坏会被官方校验器拒绝，因此在这里 fail-fast）。
 * @param manifest - tarball 内的 package.json。
 * @returns { url, directory? } 或 undefined。
 * @throws {MarketInputError} 声明了 repository 但字段不合官方规则。
 */
function requireRepository(manifest) {
  const repository = manifest.repository
  if (repository === undefined || repository === null) return undefined
  if (typeof repository !== 'object' || Array.isArray(repository)) {
    throw new MarketInputError('package.json repository 必须是对象: ' + JSON.stringify(repository))
  }
  let url = undefined
  if (repository.url !== undefined && repository.url !== null) {
    if (typeof repository.url !== 'string' || repository.url.trim() === '') {
      throw new MarketInputError('package.json repository.url 必须是非空字符串: ' + JSON.stringify(repository.url))
    }
    const stripped = repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
    let parsed
    try {
      parsed = new URL(stripped)
    } catch {
      throw new MarketInputError('package.json repository.url 不是绝对 URL: ' + JSON.stringify(repository.url))
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new MarketInputError('package.json repository.url 必须是 http(s)（官方索引规则）: ' + JSON.stringify(repository.url))
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new MarketInputError('package.json repository.url 不能带凭据: ' + JSON.stringify(repository.url))
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new MarketInputError('package.json repository.url 不能带查询串或片段: ' + JSON.stringify(repository.url))
    }
    url = stripped
  }
  const directory = requireRepositoryDirectory(repository.directory)
  if (url === undefined) return undefined
  return directory === undefined ? { url } : { url, directory }
}

/** 去掉 URL 末尾斜杠（拼接图标 URL 用）。 */
function trimTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

/** XML 文本转义（图标 aria-label 用）。 */
function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 渲染一个确定性图标 SVG（内联路径，不引用外部资源）。 */
function renderIcon(display) {
  const label = escapeXml(display.title.zh + ' / ' + display.title.en)
  const lines = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="' + label + '">',
    '  <rect width="64" height="64" rx="14" fill="' + display.icon.background + '"/>',
  ]
  for (const path of display.icon.paths) lines.push('  ' + path)
  lines.push('</svg>')
  lines.push('')
  return lines.join('\n')
}
/**
 * 离线校验一个已生成的站点（CI 在提交 market/ 目录前跑；本机用 node scripts/plugin-market.mjs check）。
 *
 * 校验分四层，任何一条失败都进 errors（不短路，一次报全）：
 *   1. 文件集合恰好是 index.json + 每个插件一个图标 + 每个插件一个 packument；
 *   2. JSON 是规范序列化（两空格缩进 + 结尾换行）——外部手改会在这里被发现；
 *   3. 用官方 parseMarketIndex 校验格式，并与展示元数据（名称/顺序/图标/子路径）对齐；
 *   4. 索引与静态 registry 交叉一致：registry 常量、版本集合、engines.dsh（必须是单个精确
 *      宿主版本 pin，映射版本还能由保留的来源字段离线复核）、publishTimestamp、
 *      dist.integrity/shasum 形态，以及每条 dist.tarball 精确等于该版本的 Release 资产 URL；
 *   5. 运行期依赖：每个插件的最新版本必须在 packument 的来源记录里零运行期依赖（否则
 *      error——索引安装后同 profile 的后续 pnpm 操作会去静态 registry 解析它们而 404）；
 *      历史版本带运行期依赖（tarball 不可变）只进 warnings。
 * @param input - { files: Map<相对路径,文本>, repo?, baseUrl?, registryUrl?, expectedNames?,
 *   parseIndex: (json, indexUrl) => MarketIndex }
 * @returns { ok, errors, warnings, summary: { plugins, versionCount, digest } }；ok 只看 errors。
 */
export function validateSite(input) {
  const repo = input.repo === undefined ? DEFAULT_GITHUB_REPO : input.repo
  const baseUrl = trimTrailingSlash(input.baseUrl === undefined ? rawMarketBaseUrl(repo) : input.baseUrl)
  const registryUrl = normalizeRegistryUrl(input.registryUrl === undefined ? defaultRegistryUrl(repo) : input.registryUrl)
  const expectedNames = input.expectedNames === undefined ? expectedNamesFromDisplay() : input.expectedNames
  if (typeof input.parseIndex !== 'function') throw new MarketInputError('validateSite 需要注入官方 parseMarketIndex')
  const files = input.files instanceof Map ? input.files : new Map(Object.entries(input.files))
  const errors = []
  const warnings = []
  const indexUrl = baseUrl + '/index.json'
  const index = (function () {
    const text = files.get('index.json')
    if (text === undefined) {
      errors.push('站点缺少 index.json')
      return undefined
    }
    let value
    try {
      value = JSON.parse(text)
    } catch (error) {
      errors.push('index.json 不是合法 JSON: ' + String(error && error.message ? error.message : error))
      return undefined
    }
    if (text !== serializeJson(value)) errors.push('index.json 不是规范序列化（两空格缩进 + 结尾换行）')
    try {
      return input.parseIndex(value, indexUrl)
    } catch (error) {
      errors.push('官方 parseMarketIndex 拒绝索引: ' + String(error && error.message ? error.message : error))
      return undefined
    }
  })()
  const allowed = new Set(['index.json', 'README.md'])
  for (const display of Object.values(PACKAGE_DISPLAY)) allowed.add('icons/' + display.slug + '.svg')
  for (const name of Object.values(expectedNames)) allowed.add(packumentPath(name))
  for (const path of inputsSortedKeys(files)) {
    if (!allowed.has(path)) errors.push('站点含多余文件: ' + path)
  }
  for (const path of [...allowed].sort()) {
    if (!files.has(path)) errors.push('站点缺少文件: ' + path)
  }
  for (const path of inputsSortedKeys(files)) {
    if (!path.endsWith('.json') && path !== 'index.json') continue
    validateCanonicalJson(files, path, errors)
  }
  const readme = files.get('README.md')
  if (readme !== undefined && readme !== MARKET_README) errors.push('README.md 内容与生成器内置说明不一致（market/ 目录禁止手工编辑）')
  const seenNames = new Set()
  const seenTarballs = new Set()
  const nameToDir = new Map()
  for (const [dir, name] of Object.entries(expectedNames)) nameToDir.set(name, dir)
  let versionCount = 0
  if (index !== undefined) {
    const expectedOrder = Object.keys(PACKAGE_DISPLAY).filter(dir => expectedNames[dir] !== undefined)
    const expectedIndexOrder = expectedOrder.map(dir => expectedNames[dir])
    const actualOrder = index.plugins.map(plugin => plugin.name)
    if (actualOrder.join('\n') !== expectedIndexOrder.join('\n')) {
      errors.push('索引插件顺序/集合与展示元数据不一致: 期望 [' + expectedIndexOrder.join(', ') + ']，实际 [' + actualOrder.join(', ') + ']')
    }
    index.plugins.forEach((plugin, position) => {
      const dir = nameToDir.get(plugin.name)
      if (dir === undefined) {
        errors.push('索引含未知插件: ' + plugin.name)
        return
      }
      if (seenNames.has(plugin.name)) errors.push('索引插件重复: ' + plugin.name)
      seenNames.add(plugin.name)
      const display = PACKAGE_DISPLAY[dir]
      validatePlugin({ index, plugin, position, dir, display, baseUrl, registryUrl, files, errors, warnings, seenTarballs })
      versionCount += plugin.versions.length
    })
    for (const name of Object.values(expectedNames)) {
      if (!seenNames.has(name)) errors.push('索引缺少插件: ' + name)
    }
    if (index.plugins.length === 0) errors.push('索引没有任何插件')
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: { plugins: seenNames.size, versionCount, digest: siteDigest(files) },
  }
}

/** Map 的 key 排序数组（枚举顺序无关）。 */
function inputsSortedKeys(files) {
  return [...files.keys()].sort()
}

/** JSON 文件必须是规范序列化；不合法时记一条错误。 */
function validateCanonicalJson(files, path, errors) {
  const text = files.get(path)
  if (text === undefined) return
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    errors.push(path + ' 不是合法 JSON: ' + String(error && error.message ? error.message : error))
    return
  }
  if (text !== serializeJson(value)) errors.push(path + ' 不是规范序列化（两空格缩进 + 结尾换行）')
}

const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const SHASUM_RE = /^[0-9a-f]{40}$/
const TARBALL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.tgz$/

/** 校验单个插件（索引条目 + 图标 + packument 交叉一致）。 */
function validatePlugin(context) {
  const { plugin, position, dir, display, baseUrl, registryUrl, files, errors, warnings, seenTarballs } = context
  const label = 'plugins[' + String(position) + '] ' + plugin.name
  const expectedIcon = baseUrl + '/icons/' + display.slug + '.svg'
  if (plugin.icon !== expectedIcon) errors.push(label + '.icon 期望 ' + expectedIcon + '，实际 ' + String(plugin.icon))
  const iconText = files.get('icons/' + display.slug + '.svg')
  if (iconText === undefined) errors.push(label + ' 缺少图标文件 icons/' + display.slug + '.svg')
  else {
    if (!iconText.startsWith('<svg')) errors.push('icons/' + display.slug + '.svg 不是 SVG')
    if (!iconText.endsWith('\n')) errors.push('icons/' + display.slug + '.svg 不以换行结尾')
    if (!iconText.includes('aria-label=')) errors.push('icons/' + display.slug + '.svg 缺少 aria-label')
  }
  if (plugin.versions.length === 0) errors.push(label + ' 没有任何版本')
  for (let at = 1; at < plugin.versions.length; at += 1) {
    if (compareVersions(plugin.versions[at - 1].version, plugin.versions[at].version) <= 0) {
      errors.push(label + '.versions 未按版本降序排列')
      break
    }
  }
  const packumentText = files.get(packumentPath(plugin.name))
  if (packumentText === undefined) return
  let packument
  try {
    packument = JSON.parse(packumentText)
  } catch {
    return
  }
  if (packument.name !== plugin.name) errors.push('packument.name 与索引不一致: ' + String(packument.name))
  if (packument.versions === null || typeof packument.versions !== 'object') {
    errors.push('packument ' + plugin.name + ' 缺少 versions')
    return
  }
  const indexed = new Set(plugin.versions.map(version => version.version))
  const packed = new Set(Object.keys(packument.versions))
  for (const version of indexed) if (!packed.has(version)) errors.push('packument ' + plugin.name + ' 缺少版本 ' + version)
  for (const version of packed) if (!indexed.has(version)) errors.push('packument ' + plugin.name + ' 含索引未列出的版本 ' + version)
  const times = packument.time === null || typeof packument.time !== 'object' ? {} : packument.time
  for (const version of indexed) if (!Object.hasOwn(times, version)) errors.push('packument ' + plugin.name + ' 的 time 缺少 ' + version)
  let latestStable
  let latestAny
  for (const entry of plugin.versions) {
    const version = entry.version
    if (entry.source === null || typeof entry.source !== 'object' || entry.source.type !== 'npm') {
      errors.push(label + ' 版本 ' + version + ' 的 source.type 必须是 npm')
      continue
    }
    if (entry.source.registry !== registryUrl) {
      errors.push(label + ' 版本 ' + version + ' 的 source.registry 期望 ' + registryUrl + '，实际 ' + String(entry.source.registry))
    }
    if (typeof entry.engines.dsh !== 'string' || entry.engines.dsh === '') errors.push(label + ' 版本 ' + version + ' 缺少 engines.dsh')
    else if (!VERSION_RE.test(entry.engines.dsh)) {
      errors.push(label + ' 版本 ' + version + ' 的 engines.dsh 必须是单个精确 SemVer（不能带 ^/~/> 操作符、空格或 ||）：' + entry.engines.dsh)
    }
    const packedVersion = packument.versions[version]
    if (packedVersion === null || typeof packedVersion !== 'object') continue
    // 来源记录必须保留在 packument 里供离线复核：
    //  - 范围清单 → dshMarket.source = 'engines-range' + 原范围（旧 dsh.host → dsh.host 本身）；
    //  - 声明了运行期依赖的版本 → dshMarket.runtimeDependencies（名 → 范围）。
    const provenance = packedVersion.dshMarket
    let declaredRuntimeDependencies = undefined
    if (provenance !== undefined) {
      if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
        errors.push('packument ' + plugin.name + '@' + version + ' 的 dshMarket 形态非法（应为对象）')
      } else {
        const declared = provenance.declaredEnginesDsh
        if (provenance.source !== undefined || declared !== undefined) {
          if (provenance.source !== 'engines-range' || typeof declared !== 'string') {
            errors.push('packument ' + plugin.name + '@' + version + ' 的 dshMarket 来源字段形态非法（应为 { source: "engines-range", declaredEnginesDsh }）')
          } else {
            const pin = exactPinOfDeclared(declared)
            if (pin === undefined) errors.push('packument ' + plugin.name + '@' + version + ' 的 dshMarket.declaredEnginesDsh ' + JSON.stringify(declared) + ' 无法推出精确 pin')
            else if (pin !== entry.engines.dsh) errors.push('packument ' + plugin.name + '@' + version + ' 的 engines.dsh 应等于声明范围的下界 ' + pin + '，实际 ' + String(entry.engines.dsh))
          }
        }
        const runtimeDependencies = provenance.runtimeDependencies
        if (runtimeDependencies !== undefined) {
          if (runtimeDependencies === null || typeof runtimeDependencies !== 'object' || Array.isArray(runtimeDependencies)) {
            errors.push('packument ' + plugin.name + '@' + version + ' 的 dshMarket.runtimeDependencies 必须是对象（名 → 范围）')
          } else {
            const names = Object.keys(runtimeDependencies)
            if (names.length === 0) errors.push('packument ' + plugin.name + '@' + version + ' 的 dshMarket.runtimeDependencies 不能是空对象（无依赖时不写）')
            for (const name of names) {
              const range = runtimeDependencies[name]
              if (typeof range !== 'string' || range.trim() === '') errors.push('packument ' + plugin.name + '@' + version + ' 的 dshMarket.runtimeDependencies[' + JSON.stringify(name) + '] 必须是非空字符串范围')
            }
            declaredRuntimeDependencies = runtimeDependencies
          }
        }
      }
    }
    // 运行期依赖：按发布时间而不是「最新版本」判定，避免发布顺序死锁——
    // RUNTIME_DEPENDENCY_POLICY_SINCE 之后发布的版本必须为零（否则索引安装后同 profile 后续 pnpm
    // 操作会 404）；该时刻之前的 tarball 不可变，只告警；时间缺失同样只告警。
    const dependencyNames = declaredRuntimeDependencies === undefined ? [] : Object.keys(declaredRuntimeDependencies)
    if (dependencyNames.length > 0) {
      const detail = dependencyNames.map(name => name + '@' + declaredRuntimeDependencies[name]).join(', ')
      if (!Number.isInteger(entry.publishTimestamp)) {
        warnings.push('插件 ' + plugin.name + ' 的版本 ' + version + ' 声明运行期依赖（' + detail + '），但索引缺少可用的发布时间（无法判定策略范围），仅告警')
      } else if (isRuntimeDependencyBlocking(entry.publishTimestamp)) {
        errors.push('插件 ' + plugin.name + ' 的版本 ' + version + '（发布于 ' + isoSecondsOf(entry.publishTimestamp) + '）不早于运行期依赖策略生效时刻 '
          + RUNTIME_DEPENDENCY_POLICY_SINCE + '，仍声明运行期依赖（' + detail + '）：'
          + 'DSH 用 pnpm add --registry=<静态 registry> 安装，pnpm 会按 tarball 清单去静态 registry 解析它们而 404，'
          + '装过这样的插件后同 profile 的后续包操作会失败；运行期依赖必须只放 devDependencies（由宿主 runtime resolution 供给）')
      } else {
        warnings.push('插件 ' + plugin.name + ' 的版本 ' + version + '（发布于 ' + isoSecondsOf(entry.publishTimestamp) + '）早于运行期依赖策略生效时刻 '
          + RUNTIME_DEPENDENCY_POLICY_SINCE + '，声明运行期依赖（' + detail + '）：历史 tarball 不可变，仅告警；'
          + '索引安装该版本后同 profile 的后续包操作可能 404，排障见 README')
      }
    }
    const packedDsh = packedVersion.dsh
    const hostPin = packedDsh !== null && typeof packedDsh === 'object' ? packedDsh.host : undefined
    if (hostPin !== undefined) {
      const pin = exactPinOfDeclared(hostPin)
      if (pin === undefined) errors.push('packument ' + plugin.name + '@' + version + ' 的 dsh.host ' + JSON.stringify(hostPin) + ' 不是精确版本')
      else if (entry.engines.dsh !== pin) errors.push('packument ' + plugin.name + '@' + version + ' 的 engines.dsh 应等于 dsh.host 精确 pin ' + pin + '，实际 ' + String(entry.engines.dsh))
    }
    if (packedVersion.engines === null || typeof packedVersion.engines !== 'object' || packedVersion.engines.dsh !== entry.engines.dsh) {
      errors.push('packument ' + plugin.name + '@' + version + ' 的 engines.dsh 与索引不一致')
    }
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
      if (Object.hasOwn(packedVersion, section)) {
        errors.push('packument ' + plugin.name + '@' + version + ' 不得声明 ' + section
          + '（静态 registry 不含宿主依赖；pnpm --registry 会去静态 registry 解析它们而 404，运行期由宿主 runtime resolution 补齐）')
      }
    }
    if (packedVersion.dsh === null || typeof packedVersion.dsh !== 'object' || packedVersion.dsh.bundle === null || typeof packedVersion.dsh.bundle !== 'object') {
      errors.push('packument ' + plugin.name + '@' + version + ' 缺少 dsh.bundle（DSH 更新检查依赖它判定 bundle）')
    }
    const dist = packedVersion.dist
    if (dist === null || typeof dist !== 'object') {
      errors.push('packument ' + plugin.name + '@' + version + ' 缺少 dist')
      continue
    }
    const expectedTarball = 'https://github.com/' + (context.repo === undefined ? DEFAULT_GITHUB_REPO : context.repo)
      + '/releases/download/' + releaseTagFor(dir, version) + '/' + assetNameFor(dir, version)
    if (dist.tarball !== expectedTarball) errors.push('packument ' + plugin.name + '@' + version + ' 的 dist.tarball 期望 ' + expectedTarball + '，实际 ' + String(dist.tarball))
    else if (!TARBALL_RE.test(dist.tarball)) errors.push('packument ' + plugin.name + '@' + version + ' 的 dist.tarball 形态非法')
    if (typeof dist.tarball === 'string') {
      if (seenTarballs.has(dist.tarball)) errors.push('tarball URL 重复: ' + dist.tarball)
      seenTarballs.add(dist.tarball)
    }
    if (typeof dist.integrity !== 'string' || !INTEGRITY_RE.test(dist.integrity)) errors.push('packument ' + plugin.name + '@' + version + ' 的 dist.integrity 不是 sha512 SRI')
    if (typeof dist.shasum !== 'string' || !SHASUM_RE.test(dist.shasum)) errors.push('packument ' + plugin.name + '@' + version + ' 的 dist.shasum 不是 40 位 sha1')
    const time = typeof times[version] === 'string' ? Date.parse(times[version]) : Number.NaN
    if (!Number.isFinite(time)) errors.push('packument ' + plugin.name + ' 的 time.' + version + ' 不是 ISO 时间')
    else if (Math.floor(time / 1000) !== entry.publishTimestamp) errors.push('packument ' + plugin.name + ' 的 time.' + version + ' 与索引 publishTimestamp 不一致')
    if (latestAny === undefined || compareVersions(version, latestAny) > 0) latestAny = version
    if (isStable(version) && (latestStable === undefined || compareVersions(version, latestStable) > 0)) latestStable = version
  }
  const expectedLatest = latestStable === undefined ? latestAny : latestStable
  const tags = packument['dist-tags'] === null || typeof packument['dist-tags'] !== 'object' ? {} : packument['dist-tags']
  if (tags.latest !== expectedLatest) errors.push('packument ' + plugin.name + ' 的 dist-tags.latest 期望 ' + String(expectedLatest) + '，实际 ' + String(tags.latest))
}

/**
 * 从既有站点的 index.json + packument 还原「每个版本的 tarball 清单与摘要」，
 * 供 build --previous 复用：只有新版本需要重新下载 tarball，历史版本直接沿用
 * 已发布的 integrity/shasum 与展示元数据，站点字节保持不变。
 * @param input - { files: Map<相对路径,文本>, expectedNames? }
 * @returns Map<发布 tag, { manifest, integrity, shasum, publishedAt, tarball }>
 * @throws {MarketInputError} 既有站点缺少 index.json 或 packument 形态不合法。
 */
export function previousManifests(input) {
  const files = input.files instanceof Map ? input.files : new Map(Object.entries(input.files === undefined ? {} : input.files))
  const expectedNames = input.expectedNames === undefined ? expectedNamesFromDisplay() : input.expectedNames
  const indexText = files.get('index.json')
  if (indexText === undefined) throw new MarketInputError('--previous 站点缺少 index.json')
  let index
  try {
    index = JSON.parse(indexText)
  } catch {
    throw new MarketInputError('--previous 站点的 index.json 不是合法 JSON')
  }
  const nameToDir = new Map()
  for (const [dir, name] of Object.entries(expectedNames)) nameToDir.set(name, dir)
  const result = new Map()
  for (const plugin of index.plugins === undefined ? [] : index.plugins) {
    const dir = nameToDir.get(plugin.name)
    if (dir === undefined) throw new MarketInputError('--previous 站点含未知插件: ' + String(plugin.name))
    const packumentText = files.get(packumentPath(plugin.name))
    if (packumentText === undefined) throw new MarketInputError('--previous 站点缺少 packument: ' + plugin.name)
    let packument
    try {
      packument = JSON.parse(packumentText)
    } catch {
      throw new MarketInputError('--previous 站点的 packument 不是合法 JSON: ' + plugin.name)
    }
    const versions = packument.versions === null || typeof packument.versions !== 'object' ? {} : packument.versions
    const times = packument.time === null || typeof packument.time !== 'object' ? {} : packument.time
    for (const entry of plugin.versions === undefined ? [] : plugin.versions) {
      const version = entry.version
      const packed = versions[version]
      if (packed === null || typeof packed !== 'object' || packed.dist === null || typeof packed.dist !== 'object') {
        throw new MarketInputError('--previous 站点缺少 ' + plugin.name + '@' + String(version) + ' 的 packument 记录')
      }
      const publishedAt = typeof times[version] === 'string' ? Math.floor(Date.parse(times[version]) / 1000) : entry.publishTimestamp
      if (!Number.isInteger(publishedAt) || publishedAt < 0) throw new MarketInputError('--previous 站点里 ' + plugin.name + '@' + String(version) + ' 的发布时间不合法')
      const manifest = manifestFromPackument(packed, packument)
      result.set(releaseTagFor(dir, version), {
        manifest,
        integrity: packed.dist.integrity,
        shasum: packed.dist.shasum,
        publishedAt,
        tarball: packed.dist.tarball,
      })
    }
  }
  return result
}

/** 由 packument 记录还原原始 engines 声明（判断精确声明 / 范围取整 / 旧 dsh.host 三种来源）。 */
function reconstructedEngines(packed) {
  const engines = packed.engines === null || typeof packed.engines !== 'object' ? {} : { ...packed.engines }
  if (packed.dshMarket !== null && typeof packed.dshMarket === 'object' && typeof packed.dshMarket.declaredEnginesDsh === 'string') {
    engines.dsh = packed.dshMarket.declaredEnginesDsh
  } else if (packed.dsh !== null && typeof packed.dsh === 'object' && Object.hasOwn(packed.dsh, 'host')) {
    delete engines.dsh
  }
  return engines
}

/**
 * 由 packument 的来源记录还原 dependencies（--previous 重建用）。
 * packument 本身不写依赖段；声明过运行期依赖的版本把清单留在 dshMarket.runtimeDependencies，
 * 还原后 buildSite 会重新算出同样的来源记录，站点字节保持不变。
 */
function runtimeDependenciesFromPackument(packed) {
  const provenance = packed.dshMarket
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) return packed.dependencies
  const runtimeDependencies = provenance.runtimeDependencies
  if (runtimeDependencies === null || typeof runtimeDependencies !== 'object' || Array.isArray(runtimeDependencies)) return packed.dependencies
  return { ...runtimeDependencies }
}

/** 由 packument 记录还原 buildSite 需要的 package.json 子集（字段齐全时与原始清单等价）。 */
function manifestFromPackument(packed, packument) {
  const manifest = {
    name: packed.name,
    version: packed.version,
    description: typeof packed.description === 'string' ? packed.description : packument.description,
    license: packed.license,
    // 还原「生效 engines.dsh」的来源，保证 --previous 重建字节不变：
    //  - 范围取整的版本：用 dshMarket 里的原范围重新算精确 pin；
    //  - 旧 dsh.host 版本：原始清单本来就没有 engines.dsh，去掉合成值让来源重新判定为 dsh-host；
    //  - 精确声明的版本：engines.dsh 原样。
    engines: reconstructedEngines(packed),
    homepage: packed.homepage,
    repository: packed.repository === null || typeof packed.repository !== 'object'
      ? undefined
      : { type: 'git', url: packed.repository.url, directory: packed.repository.directory },
    keywords: packed.keywords,
    dependencies: runtimeDependenciesFromPackument(packed),
    optionalDependencies: packed.optionalDependencies,
    peerDependencies: packed.peerDependencies,
    peerDependenciesMeta: packed.peerDependenciesMeta,
    bin: packed.bin,
    dsh: packed.dsh,
  }
  return manifest
}
