/**
 * roots.ts — 额外根目录的规范化、分类（reject/filter）与授予集合计算。
 *
 * @module @chaoset/sandbox-extra-roots/roots
 */

import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { canonicalPath, writableRoots } from './common.js'

/** 包装状态标记:挂在被包装的底层实例上,保证幂等与跨挂载点共享。 */
export const STATE = Symbol("sandbox-extra-roots.state");

/** 取底层实例(sandbox/fs 通常就是 raw,防御性写法)。 */
export const ORIGINAL = Symbol.for("cordis.original");

/** 官方 @deepseek-ai/dsh-sandbox 的 canonical 化（符号链接按真实目标解析；解析失败返回原拼写）。 */
export function canon(path: string): string {
  return canonicalPath(path);
}

/** 展开 ~ 前缀为用户主目录（"~"、"~/"、"~\"），其余原样返回。
 * 设置页允许 ~ 拼写（用户最常见的缓存目录写法），host 在校验与
 * 规范化之前统一展开，保证 validate/normalize 两个入口看到同一路径。 */
export function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Windows 盘根:"C:"、"C:\"、"C:/"。 */
const DRIVE_ROOT_RE = /^[a-zA-Z]:[\\/]?$/;

/** warn 后过滤的系统目录(原始与 canonical 双拼写都参与匹配:macOS 上
 * /etc 的 realpath 是 /private/etc,只比字面量会漏掉)。 */
const SYSTEM_DIR_SPELLINGS = ["/etc", "/usr", "/bin", "/sbin"];

/**
 * 额外根的风险分类(remote.set 校验与 normalizeRoots 两个入口共用):
 *   - "reject":canonical 后等于 "/"、Windows 盘根或 os.homedir() 本身,
 *     或是 homedir 的词法祖先(如 macOS 的 /Users、Linux 的 /home——授予
 *     它等于放开整个 home 区),即等于放弃沙盒边界;
 *   - "filter":/etc /usr /bin /sbin 等系统目录及其词法祖先(如 macOS 的
 *     /private,其下有 realpath 后的 /private/etc 等),无写入必要且高危;
 *   - null:正常业务根(含危险根的后代——比危险根更窄,授予是安全的)。
 * 祖先判定用词法前缀:入参是各入口 canonical 化后的平台原生路径,
 * 分隔符统一,无符号链接歧义。
 */
export function classifyRoot(canonical: string): "reject" | "filter" | null {
  if (canonical === "/" || DRIVE_ROOT_RE.test(canonical)) return "reject";
  try {
    const home = homedir();
    if (home && (canonical === home || canonical === canon(home))) return "reject";
    if (home && (isLexicalAncestor(canonical, home) || isLexicalAncestor(canonical, canon(home)))) return "reject";
  } catch {}
  for (const spelling of SYSTEM_DIR_SPELLINGS) {
    if (canonical === spelling || canonical === canon(spelling)) return "filter";
    if (isLexicalAncestor(canonical, spelling) || isLexicalAncestor(canonical, canon(spelling))) return "filter";
  }
  return null;
}

/** ancestor 是否是 path 的词法祖先(真前缀目录,不含相等;两侧同为
 * canonical 平台原生路径)。 */
function isLexicalAncestor(ancestor: string, path: string): boolean {
  if (ancestor === "" || path === "" || ancestor === path) return false;
  const prefix = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return path.startsWith(prefix);
}

/**
 * 官方白名单在 bwrap/Landlock 分支已授予的根。
 *
 * 官方 writableRoots 会对缺失/非目录/符号链接的额外根抛 SandboxInvalidRootError；
 * 这里宁可按"官方未授予任何根"处理（最多重复插入同一根的授权片段，对
 * bwrap --bind / landlock --rw 都是幂等无害的），也不让自查异常打断 confine 包装。
 */
function officialWritableRoots(policy: SandboxExecutionPolicy): string[] {
  try {
    const roots = writableRoots(policy);
    return Array.isArray(roots) ? roots : [];
  } catch {
    return [];
  }
}

/**
 * bwrap/Landlock 分支的插入集合:与 Seatbelt 相同的 [官方根 ∪ 额外根]
 * 去重合并,再减去官方 argv 已授予的官方根——官方参数不动,插入段只补
 * 差额,避免对同一根重复 --bind/--rw(与 Seatbelt 的整表重建语义对齐)。
 */
export function extraGrantRoots(policy: SandboxExecutionPolicy, roots: readonly string[]): string[] {
  const official = officialWritableRoots(policy);
  const officialSet = new Set(official);
  return [...new Set([...official, ...roots])].filter((root) => !officialSet.has(root));
}
