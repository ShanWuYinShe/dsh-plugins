/**
 * landlock-exec.ts — landlock-exec 可执行文件的一次性解析与缓存。
 *
 * 2026-10-08 从 545 行的 src/index.ts 拆出：配置、根目录判定、landlock 解析、
 * 网关与 apply 各自成模块，入口只保留 name/inject 与 re-export。
 *
 * @module @chaoset/sandbox-extra-roots/landlock-exec
 */

import { loadLandlock } from './common.js'

/** Landlock runner 可执行路径，惰性加载（仅 Linux 且真正进入 apply 时解析）。成功永久缓存；失败不缓存——launcher 稍后安装/修复后下一次 apply 重新探测。 */
let landlockExecPromise: Promise<string | null> | null = null;

export function getLandlockExec(): Promise<string | null> | null {
  if (process.platform !== "linux") return null;
  if (landlockExecPromise === null) {
    landlockExecPromise = loadLandlock()
      .then((landlock) => landlock.launcherPath())
      .catch(() => null)
      .then((resolved) => {
        // 失败不清、成功才留：null 结果下次调用重新探测。
        if (resolved === null) landlockExecPromise = null;
        return resolved;
      });
  }
  return landlockExecPromise;
}
