/**
 * roots.ts — 额外根目录的 canonical 化与风险分类（reject/filter）。
 *
 * enforcement 已收敛到官方 `sandboxPolicy.additionalWritableRoots`（Seatbelt/
 * bwrap/Landlock/fs fence 同源消费，见 policy-merge.ts），本模块只保留配置面
 * 需要的能力：把用户填写 / patch 传入的路径 canonical 化，并按危险级别分类。
 * 原 confine argv 改写所需的官方授予集合计算已无消费方，随 SB-01 收敛删除。
 *
 * @module @chaoset/sandbox-extra-roots/roots
 */

import { homedir } from 'node:os'
import { sep } from 'node:path'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'

/** 官方 @deepseek-ai/dsh-sandbox 的 canonical 化（符号链接按真实目标解析；解析失败返回原拼写）。 */
export function canon(path: string): string {
  return canonicalPath(path);
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
