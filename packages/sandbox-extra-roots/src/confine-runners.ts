/**
 * confine-runners.ts — bash 侧 confine 的按 runner argv 改写（纯函数，可单测）。
 *
 * Seatbelt/bwrap/Landlock/Windows 四分支与运行期根身份校验/危险根复查各成
 * 模块函数，apply 只保留装配。所有分支 fail-closed：返回 null 表示"保持官方
 * argv 原样"，调用方不得自行追加。
 *
 * @module sandbox-extra-roots/confine-runners
 */

import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { seatbeltProfileArgs } from "./common.js";
import { canon, classifyRoot, extraGrantRoots } from "./roots.js";
import { existingDirectoryRoots } from "./roots-filter.js";

/** 改写分支需要的装配回调（apply 侧闭包提供）。 */
export interface ConfineRunnerDeps {
  /** 同一 key 只告警一次。 */
  warnOnce(key: string, message: string): void;
  /**
   * Seatbelt profile 漂移自检：官方 profile（空额外目录）应与本实现重建
   * 结果一致。返回 true 表示已漂移（调用方保持官方 argv 原样）。
   */
  checkSeatbeltDrift(policy: SandboxExecutionPolicy, profile: string): boolean;
}

/**
 * 运行期危险根复查:配置期的 classifyRoot 只看配置时刻的文件系统,而
 * confine 与 fs fence 每次调用都会重新 canonical 化并跟随符号链接。
 * 若 extra root 位于沙盒可写区,沙盒内的 agent 可以把它替换成指向
 * "/"、homedir 等危险根的符号链接——重新 canonical 化会得到危险根,
 * 不复查就等于给"跟随重定向"开了沙盒逃逸通道。因此每次调用对最新
 * canonical 结果重跑分类,reject/filter 一律剔除;同一侧同一根只告警
 * 一次(每次 confine 都会走到这里,不能按调用告警)。
 */
export function safeRuntimeRoots(
  roots: readonly string[],
  warned: Set<string>,
  side: string,
  warn: (message: string) => void,
): string[] {
  const safe: string[] = [];
  for (const root of roots) {
    if (classifyRoot(root) === null) {
      safe.push(root);
      continue;
    }
    const key = `runtime-danger:${side}:${root}`;
    if (!warned.has(key)) {
      warned.add(key);
      warn(`sandbox-extra-roots: extra writable root now resolves to a dangerous root (symlink swap?); not granting it to ${side}: ${root}`);
    }
  }
  return safe;
}

/**
 * 运行期额外根身份校验 + 危险根复查（confine 与 fs fence 共用）。
 *
 * 配置期 normalizeRoots 已把每个根 canonical 化后写入 state.extraRoots，因此
 * 运行期 canon(root) !== root 只有一个解释：路径身份已被替换。额外根位于
 * 沙盒可写区（如 /tmp、workspace）时，沙盒内的 agent 可以把根换成符号链接
 * 或含链接的拼写，下一次调用若跟随重定向，就等于给新目标追加授权——例如
 * 指向 ~/.ssh 这类 home 下的敏感目录（classifyRoot 只拒绝 home 本体与危险
 * 祖先，home 的后代本身是"安全"的，仅靠危险根复查挡不住）。
 *
 * 官方 @deepseek-ai/dsh-sandbox 的 additionalRoot 对额外根是「realpath !==
 * resolve 即拒绝」（lib/index.js additionalRoot：rejects missing,
 * non-directory, and symlinked entries on each call），这里保持同一姿态：
 * 不跟随、warnOnce、剔除该根。身份未变的根再走 safeRuntimeRoots 的现有
 * 危险根复查（两层都保留：身份校验挡"换成任意目录"，危险根复查挡配置期
 * 就已危险的拼写）。
 *
 * canon 解析失败时返回原拼写（官方 canonicalPath 语义），此时身份校验退化
 * 为"拼写未变"，由危险根复查与目录存在性过滤兜底；解析成功才可能跟随
 * 重定向，正是本函数要拦的情形。
 *
 * @param roots - state.extraRoots 的去重副本（元素已是配置期 canonical 拼写）。
 * @param warned - 同一侧同一根只告警一次（每次 confine 都会走到这里）。
 * @param side - 告警文案中的使用方（"bash commands" / "the fs fence"）。
 * @param warn - logger.warn。
 * @returns 可授予的根（保持入参顺序）。
 */
export function stableRuntimeRoots(
  roots: readonly string[],
  warned: Set<string>,
  side: string,
  warn: (message: string) => void,
): string[] {
  const stable: string[] = [];
  for (const root of roots) {
    const physical = canon(root);
    if (physical === root) {
      stable.push(root);
      continue;
    }
    const key = `runtime-alias:${side}:${root}`;
    if (!warned.has(key)) {
      warned.add(key);
      warn(`sandbox-extra-roots: extra writable root is no longer the physical path it was configured as (symlink swap?); not granting it to ${side}: ${root} -> ${physical}`);
    }
  }
  return safeRuntimeRoots(stable, warned, side, warn);
}

/**
 * Seatbelt:官方 argv 为 [sandbox-exec, -p, <profile>, --, ...inner]。
 * 返回重建后的完整 argv；null = 保持官方原样（漂移/分隔符缺失/错位）。
 */
export function seatbeltArgv(
  a: readonly string[],
  roots: readonly string[],
  policy: SandboxExecutionPolicy,
  deps: ConfineRunnerDeps,
): string[] | null {
  if (typeof a[0] !== "string" || typeof a[2] !== "string") return null;
  // 漂移自检:官方 profile(空额外目录)应与本实现重建结果一致。检出
  // 漂移后**放弃重建**、保持官方 argv 原样(fail-closed)——用本插件
  // 可能过时的模板整体替换官方 profile,若官方新增了限制项会被静默
  // 丢掉,沙盒比官方更宽,这对安全敏感组件不可接受。bash 侧额外根
  // 随之失效(告警注明),fs 侧放行不受影响。
  if (deps.checkSeatbeltDrift(policy, a[2])) return null;
  // inner 命令从 -- 分隔符之后取,不硬编码下标:官方若在 -p 之前
  // 后追加参数,slice(3) 会静默错位。分隔符缺失(契约漂移)时不加
  // 额外根、保持官方 argv 原样(fail-safe,与 bwrap/Landlock 同策略)。
  const sbSep = a.indexOf("--");
  if (sbSep === -1) {
    deps.warnOnce("seatbelt-separator", "[sandbox-extra-roots] seatbelt argv has no -- separator; cannot add extra writable roots");
    return null;
  }
  // 分隔符不在期望位置(profile 后紧跟 --)同样是契约漂移:官方若在
  // profile 与 -- 之间新增参数,整表重建会把它静默丢掉,沙盒比官方
  // 更宽。与分隔符缺失同策略:放弃追加,保持官方 argv 原样。
  // 漂移自检只比对 profile 文本,检不出这种形态,必须在这里挡。
  if (sbSep !== 3) {
    deps.warnOnce("seatbelt-separator-position", "[sandbox-extra-roots] seatbelt argv shape changed (args between profile and --); refusing to rebuild it — bash-side extra roots stay OFF (the fs fence still grants them)");
    return null;
  }
  // 分隔符必须原样保留：a.slice(sbSep + 1) 是从 -- **之后**取的 inner 命令，
  // 重建时必须把 "--" 自己补回去，否则 sandbox-exec 收到
  // [ -p, <profile>, bash, -c, ... ] —— 缺分隔符它会把 bash 当 profile/参数
  // 解析，macOS 上每条受限 bash 命令都执行不了（2026-10-10 实测发现：
  // 重建后 argv 长度 6、已无 "--"，而官方是 7 且含 "--"）。
  return [a[0], ...seatbeltProfileArgs(policy, [...roots]), "--", ...a.slice(sbSep + 1)];
}

/**
 * 每 root 产出一段 runner 授权 argv 片段。bwrap 无官方 grant API，
 * `--bind <root> <root>` 拼写留在插件侧（bindMountGrant）；Landlock 必须走
 * 官方 grantArgs（apply 侧注入）——@deepseek-ai/node-addon-system/landlock-run
 * 的契约明文要求消费者不得自拼 launcher flag。
 */
export type GrantFragmentBuilder = (root: string) => string[];

/** bwrap 授权片段（后挂载覆盖 --ro-bind / /）。 */
export const bindMountGrant: GrantFragmentBuilder = (root) => ["--bind", root, root];

/**
 * bwrap / Landlock 通用插入：在 -- 前插入 buildGrant 产出的授权片段。
 * 只授予当前真实存在的目录，缺失 root 会让 bwrap 启动失败。
 * 返回插入后的完整 argv；null = 保持官方原样。
 */
export function bindMountArgv(
  a: readonly string[],
  roots: readonly string[],
  policy: SandboxExecutionPolicy,
  warned: Set<string>,
  warn: (message: string) => void,
  warnOnce: (key: string, message: string) => void,
  buildGrant: GrantFragmentBuilder,
  runnerName: string,
): string[] | null {
  const dashDash = a.indexOf("--");
  if (dashDash === -1) {
    warnOnce(`${runnerName}-separator`, `[sandbox-extra-roots] ${runnerName} argv has no -- separator; cannot add extra writable roots`);
    return null;
  }
  const extra: string[] = [];
  for (const root of existingDirectoryRoots(extraGrantRoots(policy, roots), warned, "bwrap/Landlock", warn)) {
    extra.push(...buildGrant(root));
  }
  return [...a.slice(0, dashDash), ...extra, ...a.slice(dashDash)];
}
