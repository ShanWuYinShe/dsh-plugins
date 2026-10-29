#!/usr/bin/env node
/**
 * typert.mjs — 用官方 @deepseek-ai/dsh-typert-generator 生成全仓 Typert 工件。
 *
 * 工件是 lib/ 下的构建产物（已被 .gitignore 忽略），由 package.json#exports 暴露：
 * - ./typert → lib/typert.host.js + lib/typert.host.d.ts
 *   （Host 面：给 @deepseek-ai/dsh-typert-loader 注册 ctx.typert.local 用）
 * - ./remote → lib/typert.remote-client.js + .d.ts + .d.ts.map
 *   （仅含 @Remote 方法的包才有：Client 调用面，客户端 import 包自引用子路径使用）
 *
 * 输入是纯源码：生成器只分析 packages/<pkg>/src（rejectBuildOutputs 保证不读 lib/），
 * 因此可在包编译之前/之后运行，同一输入产出同字节（确定性）。产物由
 * writeWorkspaceArtifacts() 原样落盘，不经过第二套渲染逻辑。
 *
 * 只生成 host face：本仓没有独立的 client 编译面（client 代码由 esbuild 打包、
 * 由根 tsconfig.client.json 做类型检查），官方 WORKSPACE_TYPERT_FACES 同样只有 host。
 *
 * 用法：在 worktree 根或任意子目录执行 `node scripts/typert.mjs`。
 * 退出码：0 全部写成功；1 生成失败（分析/发行/写盘）；2 用法错误。
 *
 * @module dsh-plugins/scripts/typert
 */

import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TypertAnalysisError,
  TypertEmitError,
  WorkspaceTypertGenerator,
  findWorkspaceRoot,
  writeWorkspaceArtifacts,
} from '@deepseek-ai/dsh-typert-generator'

/** 本仓脚本根目录（scripts/ 的上一级）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 生成器发现贡献包时读取的 host face 聚合 tsconfig。 */
const HOST_AGGREGATE = 'tsconfig.host.json'

/** 只生成 host face 工件；client 面由 esbuild + 根 tsconfig.client.json 负责。 */
const FACES = ['host']

/** 生成失败时按阶段给出的下一步动作。 */
const STAGE_ACTIONS = {
  locate: '在仓库根或任意子目录运行 node scripts/typert.mjs；工作区根必须同时有 tsconfig.host.json 和 packages/',
  generate: '按上面的报错修源码/package.json/tsconfig.host.json 后重跑；未写出任何工件',
  write: '修文件系统错误后重跑；失败前已写出的包保留新工件，其余包保留旧工件',
}

/**
 * 扫描 packages/<pkg>/package.json，返回声明了 typert 工件导出的包名。
 * 用于与 tsconfig.host.json 的 references 交叉校验，避免「加了 ./typert 却忘了
 * 登记聚合」时静默漏生成。
 * @param root - 工作区根目录。
 * @returns 声明 ./typert 的包名列表（按包名排序）。
 */
function packagesDeclaringTypert(root) {
  const packagesDir = join(root, 'packages')
  const names = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(packagesDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const exportsField = manifest.exports
    if (exportsField === null || typeof exportsField !== 'object') continue
    if (!Object.hasOwn(exportsField, './typert')) continue
    if (typeof manifest.name === 'string') names.push(manifest.name)
  }
  return names.sort()
}

/**
 * 为整个工作区生成并写出 Typert 工件。
 * @param start - 工作区内的任意目录；向上找到同时含 tsconfig.host.json 与 packages/ 的根。
 * @returns { root, artifacts } 工作区根与写出的工件（每个包 face 一条）。
 * @throws {TypertGenerationError} 定位/生成/写盘任一阶段失败，cause 保留底层错误。
 */
export function generateTypertArtifacts(start = REPO_ROOT) {
  let root
  try {
    root = findWorkspaceRoot(start)
  } catch (cause) {
    throw new TypertGenerationError('locate', start, cause)
  }

  // 交叉校验：声明了 ./typert 的包必须能从聚合里被发现，否则生成器会静默跳过它。
  let artifacts
  try {
    const generator = new WorkspaceTypertGenerator(root, {
      // 源码面生成：不重复 tsc 诊断；遇到 lib/ 产物或无法解析的工作区包导入即失败。
      checkDiagnostics: false,
      rejectBuildOutputs: true,
    })
    const discovered = new Set(generator.discover(FACES).map(candidate => candidate.package))
    const missing = packagesDeclaringTypert(root).filter(name => !discovered.has(name))
    if (missing.length > 0) {
      throw new TypertAnalysisError(
        `typert: ${missing.join(', ')} 声明了 ./typert 导出但未被 ${HOST_AGGREGATE} 的 references 登记；`
        + '请在 tsconfig.host.json 里补充该包的 project reference',
      )
    }
    artifacts = generator.generateContributors(FACES)
  } catch (cause) {
    throw new TypertGenerationError('generate', root, cause)
  }

  try {
    writeWorkspaceArtifacts(root, artifacts)
    removeStaleHostSourcemaps(root, artifacts)
  } catch (cause) {
    throw new TypertGenerationError('write', root, cause)
  }
  return { root, artifacts }
}

/**
 * 清掉历史遗留的 host 工件 sourcemap（旧手写 src/typert.host.ts 编译产生的
 * lib/typert.host.js.map / .d.ts.map）。tsc 不会删除已删源码的产物，生成器也不
 * 覆盖它们，而 package.json#files 含 lib/ 会把它们打进 tarball——残留会让人误以为
 * 工件带 sourcemap。生成的 host 工件本身没有 sourceMappingURL，因此这些文件只可能是陈旧产物。
 * @param root - 工作区根。
 * @param artifacts - 本次写出的工件（包根相对 root）。
 */
function removeStaleHostSourcemaps(root, artifacts) {
  for (const artifact of artifacts) {
    for (const stale of ['typert.host.js.map', 'typert.host.d.ts.map']) {
      rmSync(join(root, artifact.packageRoot, 'lib', stale), { force: true })
    }
  }
}

/** 生成器失败：阶段 + 位置 + 底层错误，便于 build 与 CLI 统一呈现。 */
export class TypertGenerationError extends Error {
  /**
   * @param stage - 失败阶段。
   * @param location - 该阶段作用的目录（locate 为搜索起点，其余为工作区根）。
   * @param cause - 生成器或文件系统抛出的底层错误。
   */
  constructor(stage, location, cause) {
    super(`typert: ${stage} 失败（${location}）`, { cause })
    this.name = 'TypertGenerationError'
    this.stage = stage
    this.location = location
  }
}

/**
 * 把一个生成失败的工整报告渲染成多行文本。
 * @param error - generateTypertArtifacts 抛出的错误。
 * @returns 不含结尾换行的报告文本。
 */
export function formatTypertFailure(error) {
  const cause = error.cause
  const detail = cause instanceof TypertAnalysisError || cause instanceof TypertEmitError
    ? `${cause.name}: ${cause.message}`
    : cause instanceof Error ? (cause.stack ?? `${cause.name}: ${cause.message}`) : String(cause)
  return [
    error.message,
    ...detail.split('\n').map(line => `  ${line}`),
    STAGE_ACTIONS[error.stage] ?? '',
  ].join('\n')
}

/** 按工件列出落盘文件（与 writePackageArtifacts 的命名一致）。 */
function artifactFiles(artifact) {
  const files = [`typert.${artifact.face}.js`, `typert.${artifact.face}.d.ts`]
  if (artifact.remote !== undefined) {
    files.push('typert.remote-client.js', 'typert.remote-client.d.ts', 'typert.remote-client.d.ts.map')
  }
  return files
}

/**
 * CLI 主流程：生成并打印确定性摘要。
 * @param args - 脚本参数；当前不接受任何参数。
 * @param start - 工作区搜索起点。
 * @returns 进程退出码。
 */
export function main(args, start = process.cwd()) {
  if (args.length > 0) {
    console.error(`typert: 不接受参数（收到 ${JSON.stringify(args)}）；用法：node scripts/typert.mjs`)
    return 2
  }
  const started = Date.now()
  let result
  try {
    result = generateTypertArtifacts(start)
  } catch (error) {
    if (!(error instanceof TypertGenerationError)) throw error
    console.error(formatTypertFailure(error))
    return 1
  }
  const files = result.artifacts.length === 0
    ? []
    : result.artifacts.flatMap(artifact => artifactFiles(artifact).map(file => `${artifact.packageRoot}/lib/${file}`))
  const seconds = ((Date.now() - started) / 1000).toFixed(2)
  console.log(`typert: ${result.artifacts.length} 个包工件 / ${files.length} 个文件，用时 ${seconds}s`)
  for (const file of files) console.log(`  ${file}`)
  return 0
}

/**
 * 判断本模块是否被当作入口直接执行（build.mjs 通过 import 复用它，不能跑 CLI）。
 * 用 realpath 比较两侧，符号链接调用（bun run / 软链脚本）也能正确识别。
 * @returns 直接执行时为 true。
 */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  process.exitCode = main(process.argv.slice(2))
}
