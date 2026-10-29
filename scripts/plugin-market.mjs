#!/usr/bin/env node
// scripts/plugin-market.mjs — 插件市场索引 + 静态 npm registry 生成器（CLI）。
//
// 站点发布在仓库 market 分支（CI 生成，禁止手工编辑），通过 raw.githubusercontent 提供：
//   index.json    用户添加的「索引源」URL
//   icons/*.svg   索引里相对引用的图标
//   npm/<name>    静态 registry 的 packument（pnpm 以 %2F 编码请求 scoped 名）
//
// 三个子命令：
//   plan    查 GitHub Releases → 过滤 → 输出收录/排除清单（JSON 到 stdout，日志到 stderr）
//   build   plan + 下载/缓存资产 + 算 integrity/shasum + 写站点目录
//   check   离线校验已生成的站点（官方 parseMarketIndex + 索引/registry 交叉一致 + 规范序列化）
//
// 只下载并读取 tarball 内的 package.json，从不安装或执行包代码。输出确定性：同一批
// Releases 重复 build 得到逐字节相同的站点（不含时间戳/随机量，顺序全部显式排序）。
//
// 用法：
//   node scripts/plugin-market.mjs plan
//   node scripts/plugin-market.mjs build --out .workwork/plugin-market-site
//   node scripts/plugin-market.mjs check --out .workwork/plugin-market-site
// 参数：--repo <owner/name>、--cache <dir>、--base-url <url>、--registry-url <url>、
//       --concurrency <n>（build/plan 下载并发，默认 6）。
//
// 需要已认证的 gh CLI（GitHub API 与资产下载）；本机有代理时 gh 会继承 http(s)_proxy。

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import {
  DEFAULT_GITHUB_REPO,
  MarketInputError,
  PACKAGE_DISPLAY,
  buildSite,
  collectCandidates,
  computeIntegrity,
  computeShasum,
  defaultRegistryUrl,
  inspectManifest,
  normalizeRegistryUrl,
  previousManifests,
  readPackageJsonFromTarball,
  validateSite,
} from './lib/plugin-market-core.mjs'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CACHE = join(ROOT, '.workwork', 'plugin-market-cache')
const USAGE = [
  '用法: node scripts/plugin-market.mjs <plan|build|check> [选项]',
  '  plan                     列出版本收录/排除清单（需要 gh）',
  '  build --out <dir>        生成站点到 <dir>（需要 gh；缓存下载的 tarball）',
  '  check --out <dir>        离线校验已生成的站点',
  '选项:',
  '  --out <dir>              站点目录（build/check 必填）',
  '  --cache <dir>            tarball 缓存目录（默认 .workwork/plugin-market-cache）',
  '  --repo <owner/name>      GitHub 仓库（默认 $GITHUB_REPOSITORY 或 ' + DEFAULT_GITHUB_REPO + '）',
  '  --base-url <url>         站点根 URL（默认 raw market 分支）',
  '  --registry-url <url>     静态 registry URL（默认 <base-url>/npm/）',
  '  --concurrency <n>        下载并发（默认 6）',
  '  --previous <dir>         复用既有站点（market 分支内容）里历史版本的摘要/元数据，',
  '                           只下载新增版本的 tarball（CI 增量生成用）',
].join('\n')

/** 参数解析：支持 --flag value 与 --flag=value；只接受已知 flag。 */
const FLAGS = new Set(['out', 'cache', 'repo', 'base-url', 'registry-url', 'concurrency', 'previous'])

/**
 * 解析命令行参数。
 * @param argv - 进程参数（不含 node 与脚本路径）。
 * @returns { command, options }
 * @throws {MarketInputError} 未知子命令/参数。
 */
function parseArguments(argv) {
  const [command, ...rest] = argv
  if (command === '--help' || command === '-h') throw new HelpRequested()
  if (command === undefined) throw new UsageError('缺少子命令')
  if (command !== 'plan' && command !== 'build' && command !== 'check') {
    throw new UsageError('未知子命令: ' + command)
  }
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (!argument.startsWith('--')) throw new UsageError('未知参数: ' + argument)
    const eq = argument.indexOf('=')
    const name = eq === -1 ? argument.slice(2) : argument.slice(2, eq)
    if (!FLAGS.has(name)) throw new UsageError('未知参数: --' + name)
    let value
    if (eq !== -1) value = argument.slice(eq + 1)
    else {
      value = rest[index + 1]
      index += 1
    }
    if (value === undefined || value === '') throw new UsageError('--' + name + ' 缺少取值')
    if (Object.hasOwn(options, name)) throw new UsageError('--' + name + ' 重复出现')
    options[name] = value
  }
  return { command, options }
}

/** 请求打印用法（退出码 0）。 */
class HelpRequested extends Error {}

/** 用法错误（退出码 2，与运行时失败区分）。 */
class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

/** 仓库根：脚本所在目录的上一级。 */
function repoRoot() {
  return ROOT
}

/** 本次运行的仓库坐标。 */
function repoOf(options) {
  const env = process.env.GITHUB_REPOSITORY
  const repo = typeof options.repo === 'string' ? options.repo : typeof env === 'string' && env.includes('/') ? env : DEFAULT_GITHUB_REPO
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new MarketInputError('--repo 必须是 owner/name: ' + JSON.stringify(repo))
  return repo
}

/**
 * 读取仓库里所有发布包目录：packages/<dir>/package.json 且声明 dsh.bundle。
 * 展示元数据必须与之完全一致，否则新增发布包会被静默漏收录。
 * @returns { dirs, expectedNames } dirs 按展示 order 排序。
 */
function publishedPackages() {
  const packagesDir = join(repoRoot(), 'packages')
  const publishDirs = []
  const expectedNames = {}
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const dsh = manifest.dsh
    if (dsh === null || typeof dsh !== 'object' || dsh.bundle === null || typeof dsh.bundle !== 'object') continue
    publishDirs.push(entry.name)
    if (typeof manifest.name !== 'string' || manifest.name === '') throw new MarketInputError('packages/' + entry.name + ' 缺少 package.json name')
    expectedNames[entry.name] = manifest.name
  }
  const missing = publishDirs.filter(dir => PACKAGE_DISPLAY[dir] === undefined)
  if (missing.length > 0) {
    throw new MarketInputError('这些发布包缺少展示元数据（scripts/lib/plugin-market-core.mjs 的 PACKAGE_DISPLAY）: ' + missing.join(', '))
  }
  const extra = Object.keys(PACKAGE_DISPLAY).filter(dir => !publishDirs.includes(dir))
  if (extra.length > 0) {
    throw new MarketInputError('PACKAGE_DISPLAY 含非发布包目录: ' + extra.join(', ') + '（应为 ' + publishDirs.join(', ') + '）')
  }
  return { dirs: Object.keys(PACKAGE_DISPLAY), expectedNames }
}

/**
 * 拉取全部 Releases（gh 已认证）。
 * @param repo - owner/name。
 * @returns GitHub Releases API 数组（按 API 顺序，下游会显式排序）。
 */
async function loadReleases(repo) {
  let stdout
  try {
    const result = await execFileAsync('gh', ['api', '--paginate', '--slurp', 'repos/' + repo + '/releases?per_page=100'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    stdout = result.stdout
  } catch (error) {
    throw new MarketInputError('调用 gh api 拉取 Releases 失败（需要已认证的 gh CLI）: ' + errorText(error))
  }
  let pages
  try {
    pages = JSON.parse(stdout)
  } catch {
    throw new MarketInputError('gh api 的输出不是合法 JSON')
  }
  if (!Array.isArray(pages)) throw new MarketInputError('gh api 的输出不是分页数组')
  return pages.flat()
}

/** 把子进程错误整理成一行可读文本。 */
function errorText(error) {
  if (error === null || typeof error !== 'object') return String(error)
  const stderr = typeof error.stderr === 'string' || Buffer.isBuffer(error.stderr) ? String(error.stderr).trim() : ''
  return stderr === '' ? String(error.message === undefined ? error : error.message) : stderr
}

/** 缓存目录内单个资产的路径。 */
function cachePathFor(cacheDir, assetName) {
  return join(cacheDir, 'assets', assetName.replace(/[/\\]/g, '_'))
}

/**
 * 下载（或读缓存）一个 Release 资产，返回 tarball 字节。
 * @param repo - owner/name。
 * @param candidate - collectCandidates 条目。
 * @param cacheDir - 缓存目录。
 * @returns Buffer。
 */
async function loadTarball(repo, candidate, cacheDir) {
  const path = cachePathFor(cacheDir, candidate.asset.name)
  if (existsSync(path)) return readFileSync(path)
  if (candidate.asset.id === undefined) throw new MarketInputError('Release 资产缺少 id，无法下载: ' + candidate.asset.name)
  let bytes
  try {
    const result = await execFileAsync('gh', ['api', '-H', 'Accept: application/octet-stream', 'repos/' + repo + '/releases/assets/' + String(candidate.asset.id)], {
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
    })
    bytes = result.stdout
  } catch (error) {
    throw new MarketInputError('下载资产失败 ' + candidate.asset.name + ': ' + errorText(error))
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
  return bytes
}

/**
 * 并发受限的 map。
 * @param items - 输入数组。
 * @param limit - 并发上限。
 * @param mapper - 异步映射函数。
 * @returns 与输入同序的结果数组。
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = []
  const size = Math.max(1, Math.min(limit, items.length))
  for (let worker = 0; worker < size; worker += 1) {
    workers.push((async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        results[index] = await mapper(items[index], index)
      }
    })())
  }
  await Promise.all(workers)
  return results
}

/**
 * 读取既有站点（market 分支内容），还原历史版本的摘要与元数据。
 * 目录不存在或没有 index.json 时返回空 Map（首次生成/回填场景），只告警不失败。
 * @param previousDir - 既有站点目录。
 * @param expectedNames - dir → 包名。
 * @returns Map<tag, { manifest, integrity, shasum, publishedAt, tarball }>
 */
function loadPrevious(previousDir, expectedNames) {
  if (previousDir === undefined) return new Map()
  if (!existsSync(join(previousDir, 'index.json'))) {
    process.stderr.write('plugin-market: --previous 目录没有 index.json（首次生成或回填），本次全量下载 tarball\n')
    return new Map()
  }
  const files = readSite(previousDir)
  const previous = previousManifests({ files, expectedNames })
  process.stderr.write('plugin-market: 复用既有站点 ' + String(previous.size) + ' 个历史版本（无需重复下载 tarball）\n')
  return previous
}

/**
 * 为候选版本补充 tarball 摘要（integrity/shasum）与 tarball 内 package.json。
 * 既有站点里已收录的版本直接复用（站点字节因此保持不变），其余版本下载 tarball 并计算。
 * @param repo - owner/name。
 * @param candidates - collectCandidates 条目。
 * @param cacheDir - 缓存目录。
 * @param concurrency - 下载并发。
 * @param previous - loadPrevious 的结果。
 * @returns { inspected: Map<tag, { candidate, manifest, integrity, shasum, reused }>, failures, reusedCount }
 */
async function loadInspection(repo, candidates, cacheDir, concurrency, previous) {
  const inspected = new Map()
  const failures = []
  let completed = 0
  let reused = 0
  const results = await mapLimit(candidates, concurrency, async (candidate) => {
    const prior = previous.get(candidate.tag)
    if (prior !== undefined) {
      reused += 1
      return {
        candidate: {
          ...candidate,
          publishedAt: prior.publishedAt,
          integrity: prior.integrity,
          shasum: prior.shasum,
          asset: { ...candidate.asset, browserDownloadUrl: prior.tarball },
        },
        manifest: prior.manifest,
        integrity: prior.integrity,
        shasum: prior.shasum,
        reused: true,
      }
    }
    try {
      const bytes = await loadTarball(repo, candidate, cacheDir)
      const manifest = readPackageJsonFromTarball(bytes)
      completed += 1
      if (completed % 25 === 0) process.stderr.write('已检查资产 ' + String(completed) + '/' + String(candidates.length) + '\n')
      const integrity = computeIntegrity(bytes)
      const shasum = computeShasum(bytes)
      return { candidate: { ...candidate, integrity, shasum }, manifest, integrity, shasum, reused: false }
    } catch (error) {
      failures.push({ tag: candidate.tag, dir: candidate.dir, version: candidate.version, reason: error instanceof MarketInputError ? error.message : errorText(error) })
      return undefined
    }
  })
  for (const result of results) if (result !== undefined) inspected.set(result.candidate.tag, result)
  return { inspected, failures, reusedCount: reused }
}

/**
 * build 的目录安全校验：拒绝覆盖仓库根/含仓库内容的目录，避免 --out 传错时 rm -rf 事故。
 * @param out - 站点输出目录。
 */
function assertSafeOut(out) {
  const target = resolve(out)
  const root = repoRoot()
  if (target === root || root.startsWith(target + sep)) throw new UsageError('--out 不能是仓库目录或它的祖先: ' + target)
  if (!existsSync(target)) return
  const entries = readdirSync(target)
  if (entries.includes('.git') || entries.includes('packages') || entries.includes('scripts') || entries.includes('package.json')) {
    throw new UsageError('--out 指向含仓库内容的目录，拒绝覆盖（先确认路径）: ' + target)
  }
  const allowed = new Set(['index.json', 'README.md', 'icons', 'npm'])
  const unexpected = entries.filter(name => !allowed.has(name))
  if (unexpected.length > 0) {
    throw new UsageError('--out 目录含非站点文件，拒绝覆盖（先确认路径）: ' + unexpected.join(', '))
  }
}

/**
 * 把站点文件写到输出目录（先清空旧站点，再逐文件写入）。
 * @param out - 输出目录。
 * @param files - Map<相对路径,文本>。
 */
function writeSite(out, files) {
  assertSafeOut(out)
  const target = resolve(out)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  for (const path of [...files.keys()].sort()) {
    const filePath = join(target, path.split('/').join(sep))
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, files.get(path))
  }
}

/**
 * 递归读取站点目录为 Map<posix 相对路径,文本>。
 * @param out - 站点目录。
 * @returns Map。
 */
function readSite(out) {
  const target = resolve(out)
  if (!existsSync(target)) throw new MarketInputError('站点目录不存在: ' + target)
  const files = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.set(relative(target, full).split(sep).join('/'), readFileSync(full, 'utf8'))
    }
  }
  walk(target)
  return files
}

/** 解析出本次运行的有效配置（repo/baseUrl/registryUrl/cacheDir）。 */
function resolveConfig(options) {
  const repo = repoOf(options)
  const baseUrl = typeof options['base-url'] === 'string' ? options['base-url'] : undefined
  const registryUrl = typeof options['registry-url'] === 'string'
    ? normalizeRegistryUrl(options['registry-url'])
    : normalizeRegistryUrl(defaultRegistryUrl(repo))
  const cacheDir = typeof options.cache === 'string' ? resolve(options.cache) : DEFAULT_CACHE
  const previousDir = typeof options.previous === 'string' ? resolve(options.previous) : undefined
  const concurrency = options.concurrency === undefined ? 6 : Number(options.concurrency)
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new UsageError('--concurrency 必须是 1..32 的整数')
  return { repo, baseUrl, registryUrl, cacheDir, previousDir, concurrency }
}

/**
 * 运行子命令。
 * @param argv - 进程参数。
 * @returns 进程退出码。
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArguments(argv)
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(USAGE + '\n')
      return 0
    }
    if (!(error instanceof UsageError)) throw error
    process.stderr.write('plugin-market: ' + error.message + '\n\n' + USAGE + '\n')
    return 2
  }
  const { command, options } = parsed
  try {
    const config = resolveConfig(options)
    const { dirs, expectedNames } = publishedPackages()
    if (command === 'check') {
      if (options.out === undefined) throw new UsageError('check 需要 --out <dir>')
      const files = readSite(options.out)
      const result = validateSite({
        files,
        repo: config.repo,
        baseUrl: config.baseUrl,
        registryUrl: config.registryUrl,
        expectedNames,
        parseIndex: parseMarketIndex,
      })
      if (!result.ok) {
        for (const error of result.errors) process.stderr.write('plugin-market: check 失败: ' + error + '\n')
        process.stdout.write(JSON.stringify({ ok: false, errors: result.errors.length, summary: result.summary }) + '\n')
        return 1
      }
      process.stderr.write('plugin-market: check 通过（' + String(result.summary.plugins) + ' 个插件 / ' + String(result.summary.versionCount) + ' 个版本，digest ' + result.summary.digest + '）\n')
      process.stdout.write(JSON.stringify({ ok: true, summary: result.summary }) + '\n')
      return 0
    }
    const releases = await loadReleases(config.repo)
    const collected = collectCandidates(releases, { dirs })
    const previous = loadPrevious(config.previousDir, expectedNames)
    const { inspected, failures, reusedCount } = await loadInspection(config.repo, collected.candidates, config.cacheDir, config.concurrency, previous)
    const entries = []
    const manifests = new Map()
    const eligible = []
    for (const original of collected.candidates) {
      const inspection = inspected.get(original.tag)
      if (inspection === undefined) {
        entries.push({ dir: original.dir, name: expectedNames[original.dir], version: original.version, tag: original.tag, publishedAt: original.publishedAt, eligible: false, reason: 'tarball-unreadable' })
        continue
      }
      const candidate = inspection.candidate
      const verdict = inspectManifest(inspection.manifest, candidate, expectedNames[candidate.dir])
      entries.push({
        dir: candidate.dir,
        name: expectedNames[candidate.dir],
        version: candidate.version,
        tag: candidate.tag,
        publishedAt: candidate.publishedAt,
        eligible: verdict.eligible,
        reused: inspection.reused,
        ...verdict.eligible
          ? { enginesDsh: verdict.enginesDsh, rangeSource: verdict.rangeSource }
          : { reason: verdict.reason },
      })
      if (!verdict.eligible) continue
      eligible.push(candidate)
      manifests.set(candidate.tag, inspection.manifest)
    }
    for (const failure of failures) {
      entries.push({ dir: failure.dir, name: expectedNames[failure.dir], version: failure.version, tag: failure.tag, publishedAt: 0, eligible: false, reason: failure.reason })
    }
    const included = entries.filter(entry => entry.eligible)
    const excluded = entries.filter(entry => !entry.eligible)
    if (command === 'plan') {
      process.stdout.write(JSON.stringify({
        repo: config.repo,
        baseUrl: config.baseUrl,
        registryUrl: config.registryUrl,
        included,
        excluded,
        metadataSkipped: collected.skipped,
      }, null, 2) + '\n')
      const enginesCount = included.filter(entry => entry.rangeSource === 'engines').length
      process.stderr.write('plugin-market: plan 完成：收录 ' + String(included.length) + ' 个版本（engines.dsh ' + String(enginesCount) + ' / dsh.host 映射 ' + String(included.length - enginesCount) + '，复用历史站点 ' + String(reusedCount) + ' 个），排除 ' + String(excluded.length + collected.skipped.length) + ' 个\n')
      return 0
    }
    if (options.out === undefined) throw new UsageError('build 需要 --out <dir>')
    const site = buildSite({
      repo: config.repo,
      baseUrl: config.baseUrl,
      registryUrl: config.registryUrl,
      candidates: eligible,
      manifests,
      expectedNames,
    })
    writeSite(options.out, site.files)
    const summary = { ...site.summary, out: resolve(options.out), files: site.files.size, reused: reusedCount }
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
    process.stderr.write('plugin-market: build 完成：' + String(summary.plugins.length) + ' 个插件 / ' + String(summary.versionCount) + ' 个版本（engines.dsh ' + String(summary.rangeSources.engines) + ' / dsh.host 映射 ' + String(summary.rangeSources['dsh-host']) + '）/ ' + String(summary.files) + ' 个文件，digest ' + summary.digest + '\n')
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write('plugin-market: ' + error.message + '\n\n' + USAGE + '\n')
      return 2
    }
    if (error instanceof MarketInputError) {
      process.stderr.write('plugin-market: ' + error.message + '\n')
      return 1
    }
    process.stderr.write('plugin-market: 未预期失败: ' + (error === null || error === undefined ? String(error) : String(error.stack === undefined ? error : error.stack)) + '\n')
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
