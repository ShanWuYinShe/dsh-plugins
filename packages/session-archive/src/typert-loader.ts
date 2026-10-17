/**
 * typert-loader.ts — typert-protocol 的惰性加载与 Remote 标记机制。
 *
 * 本文件在 sandbox-extra-roots 与 session-archive 两包里**必须逐字相同**：
 * 两包刻意零运行时依赖、可独立安装，这份机制无法提为共享 npm 包，只能各持
 * 一份，靠根 `test/bundle.test.ts` 的「共享实现一致性」锁逐字比较来防漂移
 * ——改任意一侧都会红灯，请同时改另一侧。
 *
 * DSH 的 Remote 装饰器是 ECMAScript 标准装饰器语法（Node 默认未启用），
 * 这里用"手动构造装饰器上下文"的方式等价调用：Remote(name)(method, context)
 * 把标记初始化器收集起来，在模块加载时用 Object.create 模拟实例执行
 * （mark 以实例原型为准，与真实实例化等价）。
 *
 * typert-protocol 惰性加载：npm 模式从包内 node_modules 解析；file:// 模式
 * （~/.dsh/plugins/）从 harness 的 profile 依赖树解析。两者都不可用时模块
 * 加载失败，由 index.ts 的动态 import 捕获——核心功能不受影响，仅远程服务
 * （设置页 / 侧边栏面板的读写）不可用。
 */

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 安装闭包共享 fallback:$DSH_HOME/profiles/node_modules 由 harness 启动时
// heal 出来(symlink 镜像 harness 实际使用的依赖闭包,npm 安装与源码运行
// 都会建立)。优先从这里解析,保证插件与 harness 用同一模块实例;Node ESM
// 不支持目录导入,用包目录的 package.json 作 require 锚解析入口文件
// (require.resolve 默认 realpath 化,得到 harness 同源实体路径)。
// 失败返回 null,由调用方 fall through 原有解析链。
// DSH_HOME 回退下两行与 config-store.ts legacyConfigPath 同形（刻意各持一份，改一处时同步）。
function loadInstallFallback(specifier: string): Promise<any> | null {
  try {
    const dshHome = process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
    const anchor = join(dshHome, "profiles", "node_modules", specifier, "package.json");
    const real = realpathSync(createRequire(anchor).resolve(specifier));
    return import(pathToFileURL(real).href);
  } catch {
    return null;
  }
}

// @deepseek-ai/dsh-typert-protocol 是 ESM 包。Node 20 早期版本尚不支持
// require(ESM)，因此统一用 import() 加载；fallback 时先用 createRequire
// 解析出实际文件，再以 file URL 导入。
async function loadTypert(): Promise<typeof import("@deepseek-ai/dsh-typert-protocol")> {
  const fromFallback = loadInstallFallback("@deepseek-ai/dsh-typert-protocol");
  if (fromFallback !== null) return fromFallback;
  try {
    return await import("@deepseek-ai/dsh-typert-protocol");
  } catch {}
  const dshHome = process.env.DSH_HOME?.trim() ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
  const candidates = [
    join(dshHome, "profiles", "web", "package.json"),
    join(dshHome, "profiles", "tui", "package.json"),
    join(dshHome, "profiles", "headless", "package.json"),
  ];
  for (const base of candidates) {
    try {
      const resolved = createRequire(base).resolve("@deepseek-ai/dsh-typert-protocol");
      return await import(pathToFileURL(resolved).href);
    } catch {}
  }
  throw new Error("typert-protocol is unavailable (neither package deps nor harness profiles resolve it)");
}

const { Remote, TypertRemoteService } = await loadTypert();

/** 远程服务基类（typert 的 TypertRemoteService，惰性加载后转发给各包的网关）。 */
export { TypertRemoteService };

let pending: Array<{ initializers: Array<() => void> }> = [];

/** 手动标记一个类原型方法为 Remote 端点（等价 @Remote(exportName)）。 */
export function markRemoteMethod(proto: object, method: string, exportName?: string) {
  const initializers: Array<() => void> = [];
  const context = {
    kind: "method",
    name: method,
    private: false,
    static: false,
    addInitializer(fn: () => void) { initializers.push(fn); },
  } as any;
  Remote(exportName ?? method)((proto as any)[method], context);
  pending.push({ initializers });
}

/** 执行收集到的标记（mark 以 Object.getPrototypeOf(this) 为原型）。 */
export function runPendingMarks(instance: object) {
  const batch = pending;
  pending = [];
  for (const { initializers } of batch) {
    for (const init of initializers) init.call(instance);
  }
}
