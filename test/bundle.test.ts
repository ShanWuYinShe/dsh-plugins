import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
// 与 scripts/build.mjs 相同的目录派生策略,避免硬编码清单漂移。
// 与 build.mjs 一致地跳过没有 package.json 的目录:包移除后的残留目录
// (如 vision-router)不应让元数据回归测试直接 ENOENT。
const PACKAGES = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(ROOT, "packages", name, "package.json")))
  .sort();

// 客户端 bundle 冒烟需要 react 可解析；用 vi.mock 注入一个最小 stub，
// 这样 client/index.tsx 的 `import * as React from "react"` 会被桩替换，
// 且无需安装 react 运行时（仅类型/测试用，react 已是根 devDep，不发布）。
vi.mock("react", () => ({
  createElement: (...args: any[]) => ({ args }),
  Fragment: "fragment",
  useMemo: (fn: any) => fn(),
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useCallback: (fn: any) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
  // provider-usage 的 ProviderUsagePill 导入（仅模块求值期解构，本套件不渲染组件）
  useSyncExternalStore: () => null,
  default: undefined,
}));

const reactStub = {
  createElement: (...args: any[]) => ({ args }),
  Fragment: "fragment",
  useMemo: (fn: any) => fn(),
  useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
  useCallback: (fn: any) => fn,
  useEffect: () => {},
  useRef: () => ({ current: null }),
};

describe("npm bundle metadata", () => {
  for (const name of PACKAGES) {
    const pkgPath = join(ROOT, "packages", name, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const patchFile = join(ROOT, "packages", name, "cordis.patch.yml");
    const patch = readFileSync(patchFile, "utf8");
    const scopedName = `@chaoset/${name}`;

    it(`${name}: 声明 dsh.bundle.patch`, () => {
      expect(pkg.dsh?.bundle?.patch).toBe("./cordis.patch.yml");
    });
    it(`${name}: files 包含 cordis.patch.yml`, () => {
      expect(Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml")).toBe(true);
    });
    it(`${name}: exports 暴露 cordis.patch.yml`, () => {
      expect(pkg.exports?.["./cordis.patch.yml"]).toBe("./cordis.patch.yml");
    });
    it(`${name}: exports 暴露 package.json（client 发现机制依赖）`, () => {
      expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    });
    it(`${name}: package name 与 patch 一致`, () => {
      expect(pkg.name).toBe(scopedName);
    });
    it(`${name}: patch 文件存在并插入自身`, () => {
      expect(patch.includes("- insert:") && patch.includes(scopedName)).toBe(true);
    });
    it(`${name}: exports 指向 lib/index.js（ESM 产物）`, () => {
      expect(pkg.exports?.["."]).toBe("./lib/index.js");
    });
    it(`${name}: exports 指向 client/client.cjs`, () => {
      expect(pkg.exports?.["./client"]).toBe("./client/client.cjs");
    });
    it(`${name}: exports 指向 lib/typert.host.js`, () => {
      expect(pkg.exports?.["./typert"]).toBe("./lib/typert.host.js");
    });
  }
});

describe("共享实现一致性", () => {
  it("config-store 两包 src 一致", () => {
    const read = (pkg: string, file: string) =>
      readFileSync(join(ROOT, "packages", pkg, "src", file), "utf8");
    for (const file of ["config-store.ts"]) {
      expect(read("sandbox-extra-roots", file)).toBe(read("session-archive", file));
    }
  });
});

describe("client bundles", () => {
  const configServiceStub = {
    get: async () => ({ ok: true, value: { config: {} } }),
    set: async (partial: any) => ({ ok: true, value: partial }),
  };

  it("配置类包 plugins.bundle.config 注册带包名 key", async () => {
    const cases: Array<[string, string]> = [
      ["sandbox-extra-roots", "@chaoset/sandbox-extra-roots"],
    ];
    for (const [pkg, key] of cases) {
      // plugins.bundle.config 按 npm 包名 dispatch（package.json 的 name，
      // 亦即 cordis.patch.yml 的 name）；key 与包名不一致时配置表单不会
      // 出现在本插件的 Plugins 页——在此锁死对应关系。
      const pkgJson = JSON.parse(readFileSync(join(ROOT, "packages", pkg, "package.json"), "utf8"));
      expect(key).toBe(pkgJson.name);
      const mod = await import(`../packages/${pkg}/client/index.tsx`);
      const registrations: Array<{ options: any }> = [];
      const ctx = {
        slots: {
          inject: (_slot: string, fn: () => void) => { fn(); },
          register: (options: any) => registrations.push({ options }),
        },
        locale: Object.assign(() => () => "", { bind: () => () => "", register: () => {} }),
        effect: (fn: () => void) => { fn(); },
        remote: { $mount: async () => {} },
        get: (svc: string) =>
          typeof svc === "string" && svc.startsWith("remote.") ? configServiceStub : {},
      };
      await mod.apply(ctx as any);
      const item = registrations.find((r) => r.options.name === "plugins.bundle.config");
      expect(item?.options.key).toBe(key);
    }
  });

  it("session-archive 侧边栏归档入口 + remote 贡献挂载", async () => {
    const mod = await import("../packages/session-archive/client/index.tsx");
    const registrations: Array<{ options: any }> = [];
    const mounted: Array<any> = [];
    const archiveServiceStub = {
      list: async () => ({ ok: true, value: { items: [] } }),
      detail: async () => ({ ok: true, value: {} }),
      delete: async () => ({ ok: true, value: { deleted: [], failed: [], removedFromArchive: 0 } }),
      unarchive: async () => ({ ok: true, value: { restored: [], removedFromArchive: 0 } }),
    };
    // workspaces 归档集合 store 桩：验证实时订阅链路（subscribe/countOf）接线。
    const listeners = new Set<() => void>();
    let archivedIds: string[] = ["a1"];
    const workspacesStub = {
      list: {
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
        getSnapshot: () => ({ archivedSessionIds: archivedIds }),
      },
    };
    const ctx = {
      slots: {
        inject: (_slot: string, fn: () => void) => { fn(); },
        register: (options: any) => registrations.push({ options }),
      },
      locale: Object.assign(() => () => "", { bind: () => () => "", register: () => {} }),
      effect: (fn: () => void) => { fn(); },
      remote: { $mount: async (contribution: any) => mounted.push(contribution) },
      get: (svc: string) =>
        svc === "remote.sessionArchive" ? archiveServiceStub
        : svc === "workspaces" ? workspacesStub : {},
    };
    await mod.apply(ctx as any);
    const action = registrations.find((r) => r.options.name === "sidebar.footer.action");
    expect(action !== undefined && action.options.id === "session-archive").toBe(true);
    expect(mounted.length === 1 && mounted[0].package === "@chaoset/session-archive").toBe(true);
    // 实时订阅接线：store 存在时注入 subscribe/countOf，且计数跟随集合变化。
    const props = action!.options.inject();
    expect(typeof props.subscribeArchived).toBe("function");
    expect(typeof props.archivedCountOf).toBe("function");
    expect(props.archivedCountOf()).toBe(1);
    archivedIds = ["a1", "a2"];
    for (const fn of listeners) fn();
    expect(props.archivedCountOf()).toBe(2);
  });

  it("session-archive：workspaces 缺失时降级（subscribe 注入为 undefined，不挂起）", async () => {
    const mod = await import("../packages/session-archive/client/index.tsx");
    const registrations: Array<{ options: any }> = [];
    const ctx = {
      slots: {
        inject: (_slot: string, fn: () => void) => { fn(); },
        register: (options: any) => registrations.push({ options }),
      },
      locale: Object.assign(() => () => "", { bind: () => () => "", register: () => {} }),
      effect: (fn: () => void) => { fn(); },
      remote: { $mount: async () => {} },
      get: () => ({}),
    };
    await mod.apply(ctx as any);
    const action = registrations.find((r) => r.options.name === "sidebar.footer.action");
    const props = action!.options.inject();
    expect(props.subscribeArchived).toBeUndefined();
    expect(props.archivedCountOf).toBeUndefined();
  });

  it("provider-usage 额度 pill 挂载 composer dock（注册 + inject 两条取数路径）", async () => {
    // provider-usage 的 client 入口同样只运行时依赖 react 与包内文件（dsh
    // 客户端包全是 type-only 导入），可在此直接 import 真实源码做挂载冒烟。
    const mod = await import("../packages/provider-usage/client/index.tsx");
    const registrations: Array<{ options: any; component?: any }> = [];
    // modelDirectories 桩：验证有 session 时 inject 解析出的目录与 lazy load 接线。
    const directoryStub = { subscribe: () => () => {}, getSnapshot: () => ({}) };
    const directoryLoad = vi.fn(() => Promise.resolve());
    const ctx = {
      slots: {
        inject: (_slot: string, fn: () => void) => { fn(); },
        register: (options: any, component?: any) => registrations.push({ options, component }),
      },
      locale: Object.assign(() => () => "", { bind: () => () => "", register: () => () => {} }),
      effect: (fn: () => void) => { fn(); },
      remote: { $mount: async () => {} },
      get: (svc: string) =>
        svc === "modelDirectories"
          ? { directoryFor: () => ({ store: directoryStub, load: directoryLoad }) }
          : {},
    };
    await mod.apply(ctx as any);
    const dock = registrations.find((r) => r.options.name === "conversation.composer.dock");
    expect(dock !== undefined && dock.options.id === "provider-usage").toBe(true);
    expect(dock!.options.order).toBe(10);
    // 注册必须携带 pill 组件本体（register 的第二参），缺了 slot 出口无物可渲染。
    expect(typeof dock!.component).toBe("function");
    // 无 session（dock 注入器未交付 session）→ 只回译写函数，不解析模型目录。
    const bare = dock!.options.inject();
    expect(typeof bare.t).toBe("function");
    expect(bare.directory).toBeUndefined();
    expect(bare.load).toBeUndefined();
    expect(directoryLoad).not.toHaveBeenCalled();
    // 有 session → 额度目录接线：directory 即 modelDirectories 的 store，
    // load 包装目录的 lazy load（供 pill 挂载时拉取目录）。
    const seated = dock!.options.inject("session-1");
    expect(seated.directory).toBe(directoryStub);
    expect(typeof seated.load).toBe("function");
    seated.load();
    expect(directoryLoad).toHaveBeenCalledTimes(1);
  });
});

describe("settings namespace 注册（DSH 0.1.7 已移除）", () => {
  it("sandbox-extra-roots 不再导出注册函数", async () => {
    // DSH 0.1.7 移除了 settings namespace 注册体系（`settings.register`
    // 不复存在）：卡片可见性改由 Loader profile entry 与
    // `plugins.bundle.config` slot 决定，旧的注册 helper 已删除。
    const sbNS = await import("../packages/sandbox-extra-roots/src/index.js");
    expect("registerSettingsNamespace" in sbNS).toBe(false);
  });
});

// 发布产物 client.cjs 是 esbuild 打包 + window.__ModuleLoader__.load 手工
// 包裹的产物,与 TSX 源码是两条代码路径——wrapper 格式回归(双包裹、
// factory 契约变化)只有加载真实产物才能发现。test script 先跑 build,
// 因此这里总能拿到新鲜构建。
describe("client.cjs 构建产物冒烟（__ModuleLoader__ 契约）", () => {
  const reactStub = {
    createElement: (...args: any[]) => ({ args }),
    Fragment: "fragment",
  };

  it("每个包的 client.cjs 经 __ModuleLoader__.load 暴露 id 与 apply 工厂", () => {
    for (const name of PACKAGES) {
      const file = join(ROOT, "packages", name, "client", "client.cjs");
      expect(existsSync(file), `${name}: client.cjs 已构建`).toBe(true);
      const entries: any[] = [];
      const prevWindow = (globalThis as any).window;
      (globalThis as any).window = { __ModuleLoader__: { load: (entry: any) => entries.push(entry) } };
      try {
        const requireCjs = createRequire(import.meta.url);
        requireCjs(file);
        expect(entries.length === 1, `${name}: 恰好一次 load 调用`).toBe(true);
        expect(entries[0].id, `${name}: id 为 @chaoset/<pkg>`).toBe(`@chaoset/${name}`);
        expect(typeof entries[0].factory, `${name}: factory 是函数`).toBe("function");
        const mod = entries[0].factory((spec: string) =>
          spec === "react" ? reactStub
          : spec === "react/jsx-runtime" ? { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: reactStub.Fragment }
          : {});
        expect(typeof mod?.apply, `${name}: factory 返回带 apply 的模块`).toBe("function");
      } finally {
        (globalThis as any).window = prevWindow;
      }
    }
  });
});
