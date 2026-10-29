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

// 暴露 @Remote 服务面、需要构建期 Typert 工件（./typert + ./remote）的包。
// 其余包的客户端数据面走同域 HTTP 路由（webServer），不需要 Typert。
const REMOTE_PACKAGES = new Set(["sandbox-extra-roots", "session-archive"]);

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
    it(`${name}: 不得将宿主 @deepseek-ai/dsh-* 声明为 dependencies 或 optionalDependencies（防止污染 profile node_modules）`, () => {
      const forbidden = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.optionalDependencies || {}),
      ].filter((dep) => dep.startsWith("@deepseek-ai/dsh-"));
      expect(forbidden).toEqual([]);
    });
    it(`${name}: files 包含 cordis.patch.yml`, () => {
      expect(Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml")).toBe(true);
    });
    it(`${name}: files 清单固定且条条在磁盘上有货`, () => {
      // tarball 缺文件（LICENSE 合规缺失、lib 缺入口）是安装时才炸：只钉“包含谁”
      // 不够，还要钉清单本身不变 + 每条真实存在。改清单是合法需求，改这里即显式承认。
      //
      // 有 Remote 服务面的包必须在 files 里**逐条**列出 Typert 工件与 ./types：
      // 官方生成器 workspace.ts 的 validateExport 用 Array.includes 逐字校验
      // （不认目录通配，"lib" 不等于包含 lib/typert.host.js），官方发布包同样
      // 逐个列出。少列一条 = 生成失败/发布产物缺入口。
      const canonical = ["lib", "client", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE"];
      // dsh-any-connect 的独立 CLI（lib/bin.js）是构建期自包含 bundle，内联的
      // MIT 依赖清单随包发布（THIRD_PARTY_NOTICES.md 在包根、files 显式列出）。
      if (name === "dsh-any-connect") canonical.push("THIRD_PARTY_NOTICES.md");
      const expected = REMOTE_PACKAGES.has(name)
        ? [
            "lib",
            "lib/typert.host.js",
            "lib/typert.host.d.ts",
            "lib/typert.remote-client.js",
            "lib/typert.remote-client.d.ts",
            "lib/types.js",
            "lib/types.d.ts",
            "client",
            "cordis.patch.yml",
            "README.md",
            "CHANGELOG.md",
            "LICENSE",
          ]
        : canonical;
      expect(pkg.files).toEqual(expected);
      for (const entry of pkg.files as string[]) {
        expect(existsSync(join(ROOT, "packages", name, entry)), `${name}: files 里的 ${entry} 在磁盘上存在`).toBe(true);
      }
    });
    it(`${name}: 兼容声明用官方 engines.dsh，并精确匹配发布时适配的宿主版本`, () => {
      // DSH 0.2.2-alpha.2 起安装/profile 启动按引擎区间判定插件兼容性
      // （packages/boot/app-boot/src/plugin-compatibility.ts：engines.dsh 存在
      // 时单独生效，peer 不再参与）。dsh.host 是自造旧字段，不在官方
      // DshManifest 契约内，必须清零。
      //
      // 兼容声明一律写**精确宿主版本**（不带 ^ / ~ / 比较符）：每个插件版本
      // 只声明它发布时实际适配的 DSH 版本——DSH 升级后必须安装对应重新发布的
      // 插件版本（用户 2026-10-30 决策；范围会过度声明兼容性、误导用户）。
      // 依赖 range 仍是 ^<基线>（npm 依赖语义，与宿主兼容声明不同源）。
      const dshPin = pkg.engines?.dsh;
      expect(typeof dshPin, `${name}: engines.dsh 必须声明`).toBe("string");
      expect(dshPin).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      const depRanges = [
        ...Object.entries(pkg.dependencies || {}),
        ...Object.entries(pkg.devDependencies || {}),
        ...Object.entries(pkg.peerDependencies || {}),
        ...Object.entries(pkg.optionalDependencies || {}),
      ].filter(([dep]) => dep.startsWith("@deepseek-ai/dsh-"));
      expect(depRanges.length, `${name}: 至少要有一条 dsh-* 依赖供基线对照`).toBeGreaterThan(0);
      for (const [dep, range] of depRanges) {
        expect(range, `${name}: ${dep} 的 range 是 ^<engines.dsh 精确版本>`).toBe(`^${dshPin}`);
      }
      expect(pkg.dsh?.host, `${name}: 旧字段 dsh.host 不得保留`).toBeUndefined();
    });
    it(`${name}: 声明 DSH 最低支持的 Node.js 版本与宿主一致`, () => {
      // 0.2.2-alpha.2 起宿主最低 Node.js 24.9（release notes「其他变更」首条）。
      expect(pkg.engines?.node).toBe(">=24.9.0");
    });
    it(`${name}: 声明 dsh.manifestVersion 1`, () => {
      expect(pkg.dsh?.manifestVersion).toBe(1);
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
    it(`${name}: typert 工件导出与 Remote 服务面一致`, () => {
      // 只有暴露 @Remote 服务面的包才需要 ./typert（宿主工件）与 ./remote
      // （client 调用面），两者都由官方 @deepseek-ai/dsh-typert-generator 在
      // 构建期产出；没有 Remote 的包不得保留手写空工件（旧兼容物）。
      if (REMOTE_PACKAGES.has(name)) {
        // 官方生成工件同时发布 types 条件：宿主 typert-loader 取 .js，
        // 消费者与 client bundle 取 .d.ts；./types 是生成 d.ts 引用的
        // 公开边界类型子路径（@chaoset/<pkg>/types）。
        expect(pkg.exports?.["./typert"]).toEqual({
          types: "./lib/typert.host.d.ts",
          default: "./lib/typert.host.js",
        });
        expect(pkg.exports?.["./remote"]).toEqual({
          types: "./lib/typert.remote-client.d.ts",
          default: "./lib/typert.remote-client.js",
        });
        expect(pkg.exports?.["./types"]).toEqual({
          types: "./lib/types.d.ts",
          default: "./lib/types.js",
        });
      } else {
        expect(pkg.exports?.["./typert"]).toBeUndefined();
        expect(pkg.exports?.["./remote"]).toBeUndefined();
      }
    });
    it(`${name}: 构建产物齐全（入口 / 客户端 / 按需 typert）`, () => {
      // 只钉映射字符串不够：构建若静默少产出文件，字符串检查照样绿，
      // 而 tarball 会缺入口（宿主加载时才炸）。client.cjs 已有冒烟覆盖存在性。
      const required = ["lib/index.js", "client/client.cjs"];
      if (REMOTE_PACKAGES.has(name)) {
        required.push(
          "lib/typert.host.js",
          "lib/typert.host.d.ts",
          "lib/typert.remote-client.js",
          "lib/typert.remote-client.d.ts",
          "lib/types.js",
          "lib/types.d.ts",
        );
      }
      for (const file of required) {
        expect(existsSync(join(ROOT, "packages", name, file)), `${name}: ${file} 已构建`).toBe(true);
      }
    });
    it(`${name}: exports 只用标准键集合`, () => {
      // 官方 package-surface 规则：exports 键集合固定，避免每包自造用途。
      const standard = new Set([".", "./client", "./types", "./typert", "./remote", "./locale/*.json", "./cordis.patch.yml", "./package.json"]);
      for (const key of Object.keys(pkg.exports ?? {})) {
        expect(standard.has(key), `${name}: 非标准 exports 键 ${key}`).toBe(true);
      }
    });
  }
});

describe("共享实现一致性", () => {
  it("config-store 只存在于真正需要配置持久化的包", () => {
    // config-store 只服务于「设置页写回 profile patch」：sandbox-extra-roots
    // 有配置卡所以需要；session-archive 的配置只从 patch 读、没有保存入口，
    // 2026-10-29 清理时删除了它的副本。两包逐字一致的旧共享锁随之作废，
    // 这里改成断言归属，防止无消费者的副本重新长回来。
    expect(existsSync(join(ROOT, "packages", "sandbox-extra-roots", "src", "config-store.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "packages", "session-archive", "src", "config-store.ts"))).toBe(false);
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

  it("client apply() 的兜底边界对真实入口成立（slot 注入抛错不穿透）", async () => {
    // 此前这条判据靠两份「镜像测试」——它们在 spec 里抄一遍 apply() 再断言，
    // 故对真实入口零覆盖（源码改了它们也不会红）。这里直接 import 真实入口
    // （本文件的 react vi.mock 已让浏览器专用依赖可在 node 下解析），让注册
    // 函数抛出异常，断言 apply() 吞掉异常并保留已完成的注册。
    // 四包同标准：slot 注入抛错不得穿透（各包 apply 内的 try/catch 兜底）。
    const expectedError: Record<string, string> = {
      "dsh-any-connect": "client card failed to load",
      "provider-usage": "client pill failed to load",
      "session-archive": "client panel failed to load",
      "sandbox-extra-roots": "client card failed to load",
    };
    for (const pkg of ["dsh-any-connect", "provider-usage", "session-archive", "sandbox-extra-roots"]) {
      const mod = await import(`../packages/${pkg}/client/index.tsx`);
      const registrations: any[] = [];
      const errors: unknown[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const ctx = {
          slots: {
            inject: (_slot: string, fn: () => void) => { fn(); },
            register: (options: any) => {
              registrations.push(options);
              // 第二个注册抛错：模拟 DSH 客户端契约变更（slot 改名/key 变化）。
              if (registrations.length === 1) throw new Error("keyed slot requires options.key");
            },
          },
          locale: Object.assign(() => () => "", { bind: () => () => "", register: () => () => {} }),
          effect: (fn: () => void) => { fn(); },
          remote: { $mount: async () => {} },
          get: () => ({}),
          // provider-usage 注册期直接 ctx.resources.register 额度协议 provider
          // （单一 resource 流通道，注册期不解析任何可选服务）。这里桩出最小
          // register，其余包不依赖它。
          resources: { register: () => () => {} },
        };
        // 同步包抛在调用栈、异步包（session-archive/sandbox-extra-roots）
        // 拒在微任务：包一层 async IIFE 统一成 Promise 断言，兜底后必须
        // resolve 而不是 reject。
        await expect(
          (async () => { await mod.apply(ctx as any); })(),
          `${pkg}: apply 不得把异常抛给宿主 loader`
        ).resolves.toBeUndefined();
        expect(errors.length, `${pkg}: 失败必须在 console.error 里可见`).toBe(1);
        expect(String(errors[0])).toContain(expectedError[pkg]);
        if (pkg === "dsh-any-connect") {
          // 兜底占位：真卡片注册炸了之后，同 key 的静态占位必须挂上去，
          // 用户看到一行失败提示而不是空白（mock 的 register 只在首次抛错）。
          expect(registrations.length, "占位注册必须发生").toBe(2);
          expect(registrations[1].key, "占位与真卡片同 key").toBe("@chaoset/dsh-any-connect");
        }
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    }
  });

  it("provider-usage 额度 pill 挂载 composer dock（对齐宿主 pill 的常量 inject 形状）", async () => {
    // provider-usage 的 client 入口同样只运行时依赖 react 与包内文件（dsh
    // 客户端包全是 type-only 导入），可在此直接 import 真实源码做挂载冒烟。
    const mod = await import("../packages/provider-usage/client/index.tsx");
    const registrations: Array<{ options: any; component?: any }> = [];
    // modelDirectories 桩：验证组件渲染期经 resolveSeat 解析出目录与 lazy load。
    const directoryStub = { subscribe: () => () => {}, getSnapshot: () => ({}) };
    const directoryLoad = vi.fn(() => Promise.resolve());
    // resources 服务桩：本包 apply 期注册协议 'provider-usage' 的 resource
    // provider（单一数据通道）。缺它则 apply 抛错、dock 注册不会发生。
    const registeredProtocols: string[] = [];
    const ctx = {
      slots: {
        inject: (_slot: string, fn: () => void) => { fn(); },
        register: (options: any, component?: any) => registrations.push({ options, component }),
      },
      locale: Object.assign(() => () => "", { bind: () => () => "", register: () => () => {} }),
      effect: (fn: () => void) => { fn(); },
      remote: { $mount: async () => {} },
      resources: {
        register: (provider: any) => {
          registeredProtocols.push(provider.protocol);
          return () => {};
        },
      },
      get: (svc: string) =>
        svc === "modelDirectories"
          ? { directoryFor: () => ({ store: directoryStub, load: directoryLoad }) }
          : {},
    };
    await mod.apply(ctx as any);
    // 注册期必须完成协议 provider 注册：这是额度数据唯一来源（无轮询兜底）。
    expect(registeredProtocols).toEqual(["provider-usage"]);
    // 与宿主自带 pill（dsh-client-ui-chat 的 activity/usage）同一形状：直接
    // ctx.slots.inject 注册，**不等**任何可选服务。等服务的写法会让 entry 的
    // 存活与目录服务生命周期耦合，而宿主对 inject 结果永久缓存、对 render 期
    // 抛错永久 abdicate——两条都表现为「pill 莫名其妙不见了」。
    // 目录解析下移到组件渲染期（resolveSeat），注册期不碰会话状态。
    const dock = registrations.find((r) => r.options.name === "conversation.composer.dock");
    expect(dock !== undefined && dock.options.id === "provider-usage").toBe(true);
    expect(dock!.options.order).toBe(10);
    // 注册必须携带 pill 组件本体（register 的第二参），缺了 slot 出口无物可渲染。
    expect(typeof dock!.component).toBe("function");
    // inject 是无参常量：零参数调用即可拿到 props，且不含会话快照。
    const props = dock!.options.inject();
    expect(typeof props.t).toBe("function");
    expect(typeof props.resolveSeat).toBe("function");
    expect("directory" in props).toBe(false);
    // resolveSeat 在渲染期解析：无 sessionId 时 undefined（没有可报的账号）。
    expect(props.resolveSeat(undefined)).toBeUndefined();
    expect(directoryLoad).not.toHaveBeenCalled();
    // 有 sessionId → 解析出目录 store 与 lazy load（供 pill 挂载时拉取目录）。
    const seat = props.resolveSeat("session-1");
    expect(seat?.directory).toBe(directoryStub);
    expect(typeof seat?.load).toBe("function");
    seat!.load();
    expect(directoryLoad).toHaveBeenCalledTimes(1);
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
