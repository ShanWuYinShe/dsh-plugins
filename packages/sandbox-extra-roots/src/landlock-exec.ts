/**
 * landlock-exec.ts — 官方 landlock-run 启动器的一次性解析与缓存。
 *
 * 0.2.2 起官方把启动器从 @deepseek-ai/node-addon-landlock-run 迁到
 * @deepseek-ai/node-addon-system/landlock-run（宿主 dsh-sandbox-local 的依赖
 * 即 ~0.1.2）。本插件必须走官方 grantArgs 授权（launcher 的 flag 拼写是
 * 该包私有契约，消费者不得自拼 --ro/--rw），因此这里加载同一入口。
 *
 * @module @chaoset/sandbox-extra-roots/landlock-exec
 */

import type { grantArgs, launcherPath } from '@deepseek-ai/node-addon-system/landlock-run';

/** landlock runner 的运行时授权面：可执行路径 + 官方 grantArgs。 */
export interface LandlockRuntime {
  exec: string;
  grantArgs: (grants: { readOnly?: readonly string[]; readWrite?: readonly string[] }) => string[];
}

/** 官方 landlock-run 入口的运行时形状（类型来自官方 .d.ts）。 */
interface LandlockRunModule {
  launcherPath: typeof launcherPath;
  grantArgs: typeof grantArgs;
}

/**
 * 加载官方 landlock-run 入口。
 *
 * 只有 Linux 会走到这里，且该包以 optionalDependency 声明（平台包缺失时
 * 启动器不可用）：懒加载 + 失败返回 null 让插件在无 Landlock 的部署里
 * 照常工作（bwrap 分支不受影响）。这不是模块解析 fallback —— specifier
 * 固定，解析完全交给宿主运行时。
 */
async function loadLandlockRun(): Promise<LandlockRunModule | null> {
  try {
    const mod = await import('@deepseek-ai/node-addon-system/landlock-run');
    return { launcherPath: mod.launcherPath, grantArgs: mod.grantArgs };
  } catch {
    return null;
  }
}

/** landlock runner 运行时，惰性加载。成功永久缓存；失败不缓存——launcher 稍后安装/修复后下一次 apply 重新探测。 */
let landlockRuntimePromise: Promise<LandlockRuntime | null> | null = null;

export function getLandlockRuntime(): Promise<LandlockRuntime | null> | null {
  if (process.platform !== "linux") return null;
  if (landlockRuntimePromise === null) {
    landlockRuntimePromise = loadLandlockRun()
      .then((mod) => {
        if (mod === null) return null;
        try {
          return { exec: mod.launcherPath(), grantArgs: mod.grantArgs };
        } catch {
          // 平台包缺失/路径解析失败：视为本机无 Landlock 启动器。
          return null;
        }
      })
      .then((resolved) => {
        // 失败不清、成功才留：null 结果下次调用重新探测。
        if (resolved === null) landlockRuntimePromise = null;
        return resolved;
      });
  }
  return landlockRuntimePromise;
}
