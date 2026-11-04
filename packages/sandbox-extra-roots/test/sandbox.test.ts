import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteError, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxExecutionPolicy } from "@deepseek-ai/dsh-sandbox";
import { apply } from "../src/index.js";
import { canon } from "../src/roots.js";

/**
 * sandbox-extra-roots 的 apply 级行为（SB-01 收敛后的方案 A）：
 *
 * - 设置页配置的额外可写根被并入官方 `sandboxPolicy.resolve()` 的
 *   `additionalWritableRoots`（官方 Seatbelt/bwrap/Landlock/fs fence 同源消费，
 *   本包不再包装 confine / fs.checkedTarget）；
 * - 引用计数与还原：Loader 行 reload 时新旧 entry 短暂并存，最后一个挂载点
 *   退出才还原官方 resolve；
 * - 过滤：缺失目录、运行期被换成符号链接的根不并入（避免官方 enforcement
 *   因 SandboxInvalidRootError 打断整条沙盒调用）；
 * - SB-12 降级可见：policy 服务缺失时 apply 不静默，Remote get() 返回 degraded。
 * - Remote 服务面（get/set、RemoteError 归一化、configEditor 合并基）沿用上一轮契约。
 *
 * 平台无关：目录取自运行时 mkdtemp，路径断言用 canon() 对齐。
 */

const prevHome = process.env.HOME;
const prevDshHome = process.env.DSH_HOME;

let fakeHome: string;
/** 每个用例一份全新的额外根目录（避免跨进程/跨用例的共享可变状态）。 */
let EXTRA: string;

beforeEach(() => {
  // 目录拼写取 canon()：macOS 的 /var 是 /private/var 的符号链接，后续
  // 「根被换成符号链接」用例必须让配置期拼写与实际物理拼写一致，否则
  // canon 差异会来自 tmpdir 本身而不是用例构造的替换，断言不再确定。
  fakeHome = canon(mkdtempSync(join(tmpdir(), "ser-fh-")));
  EXTRA = canon(mkdtempSync(join(tmpdir(), "ser-extra-")));
  process.env.HOME = fakeHome;
  process.env.DSH_HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = prevHome;
  process.env.DSH_HOME = prevDshHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(EXTRA, { recursive: true, force: true });
});

const WS = "/ws";

/** 官方 policy service 的最小面：resolve 由用例提供（可返回固定引用）。 */
interface FakePolicy {
  resolve(request?: unknown): SandboxExecutionPolicy;
}

function makePolicy(factory: (request?: unknown) => SandboxExecutionPolicy = () => ({ mode: "workspace-write", workspaceRoot: WS })): FakePolicy {
  return { resolve: factory };
}

interface CtxOptions {
  /** 传入 false 模拟部署缺少 ctx.sandboxPolicy（降级路径）。 */
  policy?: FakePolicy | undefined;
  warn?: (message: string) => void;
}

/**
 * 保真 ctx mock：effect 的 execute 返回值（若为函数）是 disposer，收集起来
 * 供 disposeAll() 模拟宿主卸载；plugin() 用假 reflect 实例化 gateway。
 */
function makeCtx(options: CtxOptions = {}): any {
  const disposers: Array<() => void> = [];
  const warnings: string[] = [];
  const ctx: any = {
    sandboxPolicy: options.policy === undefined ? undefined : options.policy,
    disposers,
    warnings,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
    logger: {
      warn: (message: string) => {
        warnings.push(message);
        options.warn?.(message);
      },
    },
    // 官方 configEditor fake：记录 edit 写入的候选 config（"持久化到 profile
    // patch" 的内容），并在每次 edit 后把写回值更新为下一次的 current
    // （模拟 Loader 对账更新 entry config）。
    fiber: { entry: { options: { id: "sandbox-extra-roots" } } },
    configEditorEdits: [] as Array<Record<string, any>>,
    configEditorCurrent: {} as Record<string, any>,
    configEditorInherited: {} as Record<string, any>,
    get(name: string) {
      if (name === "configEditor") {
        return {
          edit: async (_entry: unknown, change: (current: any, inherited: any) => any) => {
            const next = change(this.configEditorCurrent, this.configEditorInherited);
            this.configEditorEdits.push(next);
            this.configEditorCurrent = next;
          },
        };
      }
      return undefined;
    },
    effect(fn: () => void | (() => void)) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    plugin(Cls: any, cfg: any) {
      const saved = this.reflect;
      this.reflect = { provide: () => {}, props: {} };
      try {
        this.gateway = new Cls(this, cfg);
      } finally {
        this.reflect = saved;
      }
    },
  };
  return ctx;
}

/** 取当前 resolve 结果里的 official 额外根（无则空数组）。 */
function additionalRoots(policy: FakePolicy): readonly string[] {
  return policy.resolve().additionalWritableRoots ?? [];
}

describe("sandbox-extra-roots host（SB-01 方案 A：并入官方 additionalWritableRoots）", () => {
  it("workspace-write 下把配置根并入官方 policy，且数组冻结", async () => {
    const policy = makePolicy();
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [EXTRA] });

    const resolved = policy.resolve();
    expect(resolved.mode).toBe("workspace-write");
    expect(resolved.additionalWritableRoots).toEqual([canon(EXTRA)]);
    expect(Object.isFrozen(resolved.additionalWritableRoots)).toBe(true);
    // 原始 workspaceRoot 等字段原样保留。
    expect(resolved.workspaceRoot).toBe(WS);
  });

  it("无额外根时返回官方原引用（不做多余分配/不改对象身份）", async () => {
    const official: SandboxExecutionPolicy = { mode: "workspace-write", workspaceRoot: WS };
    const policy = makePolicy(() => official);
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [] });
    expect(policy.resolve()).toBe(official);
  });

  it("read-only / danger-full-access 下不并入额外根（官方语义：授予无意义）", async () => {
    for (const mode of ["read-only", "danger-full-access"] as const) {
      const official: SandboxExecutionPolicy = { mode, workspaceRoot: WS };
      const policy = makePolicy(() => official);
      const ctx = makeCtx({ policy });
      await apply(ctx, { extraWritableRoots: [EXTRA] });
      expect(policy.resolve()).toBe(official);
      expect(policy.resolve().additionalWritableRoots).toBeUndefined();
    }
  });

  it("与官方已有 additionalWritableRoots 合并去重（官方顺序在前）", async () => {
    const policy = makePolicy(() => ({
      mode: "workspace-write",
      workspaceRoot: WS,
      additionalWritableRoots: Object.freeze(["/official/a", canon(EXTRA)]),
    }));
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [EXTRA, "/other"] });
    const roots = additionalRoots(policy);
    // 官方根保持在前；EXTRA 官方已有 → 不重复；/other 不存在 → 被过滤。
    expect(roots).toEqual(["/official/a", canon(EXTRA)]);
    // 全部已被官方覆盖 → 返回原引用（对象身份不变）。
    expect(policy.resolve().additionalWritableRoots).toHaveLength(2);
  });

  it("dispose 后还原官方 resolve（自有属性恢复原实现）", async () => {
    const policy = makePolicy();
    const originalResolve = policy.resolve;
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [EXTRA] });
    expect(policy.resolve).not.toBe(originalResolve);
    expect(additionalRoots(policy)).toEqual([canon(EXTRA)]);

    ctx.disposeAll();
    expect(policy.resolve).toBe(originalResolve);
    expect(policy.resolve().additionalWritableRoots).toBeUndefined();
  });

  it("多挂载点引用计数：第一个退出不还原、最后一个才还原", async () => {
    const policy = makePolicy();
    const originalResolve = policy.resolve;
    const ctxA = makeCtx({ policy });
    const ctxB = makeCtx({ policy });
    const extraB = mkdtempSync(join(tmpdir(), "ser-extra-b-"));
    try {
      await apply(ctxA, { extraWritableRoots: [EXTRA] });
      await apply(ctxB, { extraWritableRoots: [extraB] });
      // 共享状态：最后一次 apply 的生效配置（与 Loader 行 reload 语义一致）。
      expect(additionalRoots(policy)).toEqual([canon(extraB)]);

      ctxA.disposeAll();
      expect(policy.resolve).not.toBe(originalResolve);
      expect(additionalRoots(policy)).toEqual([canon(extraB)]);

      ctxB.disposeAll();
      expect(policy.resolve).toBe(originalResolve);
      expect(policy.resolve().additionalWritableRoots).toBeUndefined();
    } finally {
      rmSync(extraB, { recursive: true, force: true });
    }
  });

  it("行 reload（再 apply）后按新配置更新生效根，不影响引用计数递减", async () => {
    const policy = makePolicy();
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [EXTRA] });
    expect(additionalRoots(policy)).toEqual([canon(EXTRA)]);

    // Loader 行 reload 等价于同一 fiber 上再 apply 一次（配置变化）。
    await apply(ctx, { extraWritableRoots: [] });
    expect(additionalRoots(policy)).toEqual([]);

    ctx.disposeAll();
    expect(policy.resolve().additionalWritableRoots).toBeUndefined();
  });

  it("缺失/非目录的根被过滤且只告警一次（官方 enforcement 会拒绝这类根）", async () => {
    const missing = join(EXTRA, "not-created");
    const policy = makePolicy();
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [missing] });
    expect(policy.resolve().additionalWritableRoots).toBeUndefined();
    policy.resolve();
    policy.resolve();
    const warns = ctx.warnings.filter((w: string) => w.includes("does not exist") && w.includes(canon(missing)));
    expect(warns).toHaveLength(1);
  });

  it("运行期根被换成符号链接后不并入（防沙盒内重定向），且只告警一次", async () => {
    const root = join(EXTRA, "cache");
    mkdirSync(root, { recursive: true });
    const decoy = join(EXTRA, "decoy");
    mkdirSync(decoy, { recursive: true });
    const policy = makePolicy();
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [root] });
    expect(additionalRoots(policy)).toEqual([canon(root)]);

    rmSync(root, { recursive: true, force: true });
    symlinkSync(decoy, root, "dir");
    // 两次 resolve 都不得跟随链接目标，也不得授予被替换后的拼写。
    expect(additionalRoots(policy)).toEqual([]);
    expect(additionalRoots(policy)).toEqual([]);
    const warns = ctx.warnings.filter((w: string) => w.includes("no longer the physical path") && w.includes(canon(root)));
    expect(warns).toHaveLength(1);
  });

  it("配置被 canonical 化与去重（符号链接拼写 → 真实路径）", async () => {
    const real = join(EXTRA, "real");
    mkdirSync(real, { recursive: true });
    const link = join(EXTRA, "link");
    symlinkSync(real, link, "dir");
    const policy = makePolicy();
    const ctx = makeCtx({ policy });
    await apply(ctx, { extraWritableRoots: [link, real, link] });
    // normalizeRoots 把链接展开为真实路径并去重 → 只授予一个根。
    expect(additionalRoots(policy)).toEqual([canon(real)]);
  });
});

describe("sandbox-extra-roots host（SB-12 降级可见）", () => {
  it("policy 服务缺失时 apply 不抛错：warn 明确写 NOT in effect，Remote get() 返回 degraded", async () => {
    const ctx = makeCtx({ policy: undefined });
    await apply(ctx, { extraWritableRoots: [EXTRA] });
    expect(ctx.warnings.some((w: string) => w.includes("NOT in effect"))).toBe(true);
    // gateway 仍注册：设置卡能显示降级原因，而不是静默失效。
    expect(ctx.gateway).toBeDefined();
    const result = ctx.gateway.get();
    expect(result.config.extraWritableRoots).toEqual([EXTRA]);
    expect(result.degraded?.reason).toMatch(/sandboxPolicy/);
  });

  it("正常生效时 get() 不带 degraded", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx, { extraWritableRoots: [EXTRA] });
    expect(ctx.gateway.get().degraded).toBeUndefined();
  });
});

describe("sandbox-extra-roots Remote（get/set、错误归一化、合并基）", () => {
  it("remote set 经官方 configEditor 写入 profile patch", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx, { extraWritableRoots: [] });
    await ctx.gateway.set({ extraWritableRoots: ["/tmp/hot"] });
    expect(ctx.configEditorEdits.at(-1)).toEqual(
      expect.objectContaining({ extraWritableRoots: ["/tmp/hot"] }),
    );
  });

  it("写回以官方 current/inherited 为合并基：不清掉已有字段，保存后快照更新", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    ctx.configEditorCurrent = { extraWritableRoots: ["/tmp/existing"], keepMe: 1 };
    ctx.configEditorInherited = { bundleOnly: true };
    await apply(ctx, { extraWritableRoots: [] });

    await ctx.gateway.set({ extraWritableRoots: ["/tmp/first"] });
    expect(ctx.configEditorEdits.at(-1)).toEqual({
      extraWritableRoots: ["/tmp/first"],
      bundleOnly: true,
      keepMe: 1,
    });
    expect(ctx.gateway.get()).toEqual({ config: { extraWritableRoots: ["/tmp/first"] } });

    // 空 partial（"只改其它字段"）：本行已有字段不被清空。
    await ctx.gateway.set({});
    expect(ctx.configEditorEdits.at(-1)).toEqual({
      extraWritableRoots: ["/tmp/first"],
      bundleOnly: true,
      keepMe: 1,
    });

    await ctx.gateway.set({ extraWritableRoots: ["/tmp/second"] });
    expect(ctx.gateway.get()).toEqual({ config: { extraWritableRoots: ["/tmp/second"] } });
  });

  it("请求里的未知字段不写入 profile patch（只并入白名单字段）", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx, { extraWritableRoots: [] });
    await ctx.gateway.set({
      extraWritableRoots: ["/tmp/a"],
      futureField: "should-not-leak",
    } as unknown as { extraWritableRoots: string[] });
    expect(ctx.configEditorEdits.at(-1)).toEqual({ extraWritableRoots: ["/tmp/a"] });
  });

  it("校验失败抛官方 RemoteError(invalid-config)，details 含 field/value", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx, { extraWritableRoots: [] });
    const failure = await ctx.gateway
      .set({ extraWritableRoots: ["relative/path"] })
      .then(() => null, (error: unknown) => remoteErrorOf(error));
    expect(failure).toMatchObject({
      code: "sandbox-extra-roots/invalid-config",
      details: { field: "extraWritableRoots", value: '["relative/path"]' },
    });
    expect(failure).toBeInstanceOf(RemoteError);
    expect(ctx.configEditorEdits).toHaveLength(0);
  });

  it("危险根同样归一化为 invalid-config（details.value 保留原始值）", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx, { extraWritableRoots: [] });
    const failure = await ctx.gateway
      .set({ extraWritableRoots: ["/"] })
      .then(() => null, (error: unknown) => remoteErrorOf(error));
    expect(failure).toMatchObject({
      code: "sandbox-extra-roots/invalid-config",
      details: { field: "extraWritableRoots", value: '["/"]' },
    });
  });

  it("部署无 configEditor（无 fiber entry）时 set 抛 RemoteError(config-unavailable)", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    ctx.fiber = undefined;
    await apply(ctx, { extraWritableRoots: [] });
    await expect(ctx.gateway.set({ extraWritableRoots: [] })).rejects.toMatchObject({
      code: "sandbox-extra-roots/config-unavailable",
      details: {},
    });
  });
});

describe("sandbox-extra-roots 错误路径（覆盖降级/兜底分支）", () => {
  it("policy.resolve 不是函数：apply 降级（不抛给宿主），get() 带原因", async () => {
    const ctx = makeCtx({ policy: { resolve: undefined } as unknown as FakePolicy });
    await apply(ctx, { extraWritableRoots: [EXTRA] });
    expect(ctx.gateway.get().degraded?.reason).toMatch(/resolve is not a function/);
    expect(ctx.warnings.some((w: string) => w.includes("NOT in effect"))).toBe(true);
    // 未安装包装：契约漂移的 resolve 保持原样（没有被替换成包装函数）。
    expect(ctx.sandboxPolicy.resolve).toBeUndefined();
  });

  it("gateway 注册失败：只告警，不影响 enforcement（apply 不抛）", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    ctx.plugin = () => {
      throw new Error("gateway boom");
    };
    await expect(apply(ctx, { extraWritableRoots: [EXTRA] })).resolves.toBeUndefined();
    expect(ctx.warnings.some((w: string) => w.includes("settings gateway failed") && w.includes("gateway boom"))).toBe(true);
    // enforcement 仍然生效：policy 里已并入根。
    expect(ctx.sandboxPolicy.resolve().additionalWritableRoots).toEqual([canon(EXTRA)]);
  });

  it("apply 不带 config：使用 DEFAULT_CONFIG（空根）", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx);
    expect(ctx.gateway.get()).toEqual({ config: { extraWritableRoots: [] } });
  });

  it("logger 缺失时降级路径不抛（可选链兜底）", async () => {
    const ctx = makeCtx({ policy: undefined });
    ctx.logger = undefined;
    await expect(apply(ctx, { extraWritableRoots: [EXTRA] })).resolves.toBeUndefined();
    expect(ctx.gateway.get().degraded?.reason).toMatch(/sandboxPolicy/);
  });

  it("gateway 注册抛非 Error 值：String 兜底后仍只告警", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    ctx.plugin = () => {
      throw "gateway-string-boom";
    };
    await expect(apply(ctx, { extraWritableRoots: [EXTRA] })).resolves.toBeUndefined();
    expect(ctx.warnings.some((w: string) => w.includes("gateway-string-boom"))).toBe(true);
  });

  it("非对象 partial：invalid-config details.field = config", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx, { extraWritableRoots: [] });
    const failure = await (ctx.gateway.set as (p: unknown) => Promise<unknown>)(null).then(
      () => null,
      (error: unknown) => remoteErrorOf(error),
    );
    expect(failure).toMatchObject({
      code: "sandbox-extra-roots/invalid-config",
      details: { field: "config", value: "null" },
    });
  });

  it("循环引用值：details.value 走 String 兜底（序列化不抛）", async () => {
    const ctx = makeCtx({ policy: makePolicy() });
    await apply(ctx, { extraWritableRoots: [] });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const failure = await (ctx.gateway.set as (p: unknown) => Promise<unknown>)({ extraWritableRoots: circular }).then(
      () => null,
      (error: unknown) => remoteErrorOf(error),
    );
    expect(failure).toMatchObject({
      code: "sandbox-extra-roots/invalid-config",
      details: { field: "extraWritableRoots", value: "[object Object]" },
    });
  });
});
