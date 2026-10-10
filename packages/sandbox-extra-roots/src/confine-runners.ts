/**
 * confine-runners.ts — bash 侧 confine 的按 runner argv 改写（纯函数，可单测）。
 *
 * 2026-10-10 从 apply.ts 拆出：Seatbelt/bwrap/Landlock/Windows 四分支与
 * 运行期危险根复查各成模块函数，apply 只保留装配。所有分支 fail-closed：
 * 返回 null 表示"保持官方 argv 原样"，调用方不得自行追加。
 *
 * @module sandbox-extra-roots/confine-runners
 */

import { seatbeltProfileArgs } from "./common.js";
import { classifyRoot, extraGrantRoots } from "./roots.js";
import { existingDirectoryRoots } from "./roots-filter.js";

/** 改写分支需要的装配回调（apply 侧闭包提供）。 */
export interface ConfineRunnerDeps {
  /** 同一 key 只告警一次。 */
  warnOnce(key: string, message: string): void;
  /**
   * Seatbelt profile 漂移自检：官方 profile（空额外目录）应与本实现重建
   * 结果一致。返回 true 表示已漂移（调用方保持官方 argv 原样）。
   */
  checkSeatbeltDrift(policy: any, profile: string): boolean;
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
  roots: string[],
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
 * Seatbelt:官方 argv 为 [sandbox-exec, -p, <profile>, --, ...inner]。
 * 返回重建后的完整 argv；null = 保持官方原样（漂移/分隔符缺失/错位）。
 */
export function seatbeltArgv(a: string[], roots: string[], policy: any, deps: ConfineRunnerDeps): string[] | null {
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
    deps.warnOnce("seatbelt-separator", "seatbelt argv has no -- separator; cannot add extra writable roots");
    return null;
  }
  // 分隔符不在期望位置(profile 后紧跟 --)同样是契约漂移:官方若在
  // profile 与 -- 之间新增参数,整表重建会把它静默丢掉,沙盒比官方
  // 更宽。与分隔符缺失同策略:放弃追加,保持官方 argv 原样。
  // 漂移自检只比对 profile 文本,检不出这种形态,必须在这里挡。
  if (sbSep !== 3) {
    deps.warnOnce("seatbelt-separator-position", "seatbelt argv shape changed (args between profile and --); refusing to rebuild it — bash-side extra roots stay OFF (the fs fence still grants them)");
    return null;
  }
  return [a[0], ...seatbeltProfileArgs(policy, roots), ...a.slice(sbSep + 1)];
}

/**
 * bwrap (`--bind <root> <root>`) / Landlock (`--rw <root>`)：在 -- 前插入
 * 授予（后挂载覆盖 --ro-bind / /）。只授予当前真实存在的目录，缺失 root
 * 会让 bwrap 启动失败。返回插入后的完整 argv；null = 保持官方原样。
 */
export function bindMountArgv(
  a: string[],
  roots: string[],
  policy: any,
  warned: Set<string>,
  warn: (message: string) => void,
  warnOnce: (key: string, message: string) => void,
  flag: "--bind" | "--rw",
  runnerName: string,
): string[] | null {
  const dashDash = a.indexOf("--");
  if (dashDash === -1) {
    warnOnce(`${runnerName}-separator`, `${runnerName} argv has no -- separator; cannot add extra writable roots`);
    return null;
  }
  const extra: string[] = [];
  for (const root of existingDirectoryRoots(extraGrantRoots(policy, roots), warned, "bwrap/Landlock", warn)) {
    if (flag === "--bind") extra.push("--bind", root, root);
    else extra.push("--rw", root);
  }
  return [...a.slice(0, dashDash), ...extra, ...a.slice(dashDash)];
}
