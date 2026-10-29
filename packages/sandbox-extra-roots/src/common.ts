/**
 * common.ts — 沙盒能力与宿主路径工具的共享实现（@chaoset/sandbox-extra-roots）。
 *
 * 目标：在不修改全局安装的前提下，给 dsh 沙盒的 workspace-write 模式增加
 * "额外允许写入的目录"列表（工具缓存目录等）。
 *
 * 官方依赖一律静态导入：运行时由宿主的外部插件解析链提供 @deepseek-ai/*
 * 单实例（官方 package-surface.md：新增 resolve hook 被明确拒绝；宿主 profile
 * runner 的 runtime resolution 已补齐 installation 依赖）。本模块没有
 * createRequire 多级 fallback，也没有模块求值期 await。
 *
 * Seatbelt SBPL profile 与 fs fence 的包含判断仍在此实现：官方只在
 * dsh-sandbox-local / dsh-fs-sandbox 内部使用它们而未公开导出，本插件作为
 * confine/checkedTarget 的包装层需要同一语义，出处见各函数注释。
 *
 * @module @chaoset/sandbox-extra-roots/common
 */

import type { BigIntStats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';

/** 官方 @deepseek-ai/dsh-sandbox 的路径 canonical 化（同一契约，直接转发给测试与包装层）。 */
export { canonicalPath, writableRoots };

/** 转义一个路径为 SBPL 字符串字面量（与官方 profiles.ts 的 sbplString 逐字同义）。 */
function sbplString(path: string): string {
  return '"' + path.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

/**
 * 构造带额外可写目录的 Seatbelt SBPL 参数（形状与官方 seatbeltProfileArgs
 * 一致：["-p", profile]）。只在 workspace-write 模式下追加额外目录；
 * read-only 与官方行为完全一致（不允许任何写入）。
 *
 * 出处（官方实现，未公开导出）：host-repo packages/sandbox/sandbox-local/src/profiles.ts
 * seatbeltProfileArgs —— 该文件用官方共享 writableRoots(policy) 生成允许清单，
 * 本函数在同一清单上追加本插件的额外根。apply.ts 每次 confine 都做一次
 * "官方 profile（空额外目录）与本实现重建结果一致"的自检，官方模板漂移即
 * 放弃重建（fail-closed，bash 侧额外根失效，fs 侧不受影响）。
 *
 * @param policy - 逐调用解析出的沙盒策略（mode/workspaceRoot/additionalWritableRoots）。
 * @param extraRoots - 已规范化的额外可写根目录列表。
 * @returns sandbox-exec 的 profile 参数。
 */
export function seatbeltProfileArgs(policy: SandboxExecutionPolicy, extraRoots: string[]): string[] {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal ${sbplString("/dev/null")}))`
  ];
  if (policy.mode === "workspace-write") {
    const roots = [...new Set([...writableRoots(policy), ...extraRoots])];
    if (roots.length > 0) {
      forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
    }
  }
  return ["-p", forms.join(" ")];
}

// ── 以下为路径包含判断：从官方 @deepseek-ai/dsh-fs-sandbox 的 containment.ts
// 原样搬来（该实现未公开导出），保持语义逐字一致；官方契约变化时以 typecheck /
// windows-acl 等集成行为兜底。

const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);

function isMissing(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== void 0 && MISSING_CODES.has(code);
}

function comparablePath(path: string, caseSensitive: boolean) {
  return caseSensitive ? path : path.toLowerCase();
}

function isLexicallyUnder(path: string, root: string, caseSensitive: boolean) {
  const comparableTarget = comparablePath(path, caseSensitive);
  const comparableRoot = comparablePath(root, caseSensitive);
  if (comparableTarget === comparableRoot) return true;
  const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparableTarget.startsWith(prefix);
}

async function statIfPresent(path: string) {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return void 0;
    throw error;
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * 判断规范化后的目标路径是否等于某个可写根目录或位于其下。
 * 词法快路径处理常规拼写；拼写不一致时（如大小写/别名）退化为
 * 沿祖先链比对文件系统身份。
 */
export async function isPathUnder(path: string, root: string, caseSensitive: boolean = process.platform !== "win32"): Promise<boolean> {
  if (isLexicallyUnder(path, root, caseSensitive)) return true;
  const rootInfo = await statIfPresent(root);
  if (!rootInfo) return false;
  let ancestor = path;
  while (true) {
    const ancestorInfo = await statIfPresent(ancestor);
    if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true;
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
}
