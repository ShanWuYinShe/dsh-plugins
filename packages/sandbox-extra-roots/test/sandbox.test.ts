import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { apply } from "../src/index.js";
import { canonicalPath, writableRoots } from "../src/common.js";

const prevHome = process.env.HOME;
const prevDshHome = process.env.DSH_HOME;

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "ser-fh-"));
  process.env.HOME = fakeHome;
  process.env.DSH_HOME = fakeHome;
});

afterEach(() => {
  process.env.HOME = prevHome;
  process.env.DSH_HOME = prevDshHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

const WS = "/ws";
const EXTRA = "/tmp/extra";

function sbpl(roots: string[]): string {
  const forms = ["(version 1)", "(allow default)", "(deny file-write*)", '(allow file-write* (literal "/dev/null"))'];
  forms.push("(allow file-write* " + roots.map((r) => '(subpath "' + r + '")').join(" ") + ")");
  return forms.join(" ");
}

function makeSandboxMock() {
  // 镜像 DSH 0.1.6 宿主：confine 是异步实现，第三参数为 AbortSignal。
  const mock: any = {
    lastSignal: undefined as any,
    async confine(argv: string[], policy: any, signal?: any) {
      mock.lastSignal = signal;
      const roots = writableRoots(policy);
      return { argv: ["sandbox-exec", "-p", sbpl(roots), "--", ...argv], enforcement: "full", denialSignatures: [], runnerFailureRules: [] };
    },
  };
  return mock;
}

function makeFsMock() {
  return {
    async resolve(displayPath: string) { return { targetKey: displayPath }; },
    // 标注官方契约返回形状：未包装的桩只会 throw，推断成 Promise<never>
    // 会让 apply 包装后的 await 结果失去 targetKey 类型。
    async checkedTarget(target: any): Promise<{ targetKey: string }> {
      throw Object.assign(new Error("FS_SANDBOX_DENIED"), { code: "FS_SANDBOX_DENIED" });
    },
  };
}

function makeCtx(sandbox: any, fs: any): any {
  // 保真 effect mock:与 cordis 语义一致——execute 的返回值(若为函数)
  // 是 disposer,收集起来供 disposeAll() 模拟宿主卸载。
  const disposers: Array<() => void> = [];
  return {
    sandbox,
    fs,
    disposers,
    disposeAll() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
    sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: WS }) },
    logger: { warn: () => {} },
    effect(fn: () => any) {
      const dispose = fn();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    plugin(Cls: any, cfg: any) {
      const saved = this.reflect;
      this.reflect = { provide: () => {}, props: {} };
      try { this.gateway = new Cls(this, cfg); } finally { this.reflect = saved; }
    },
  };
}

describe("sandbox-extra-roots host (Seatbelt)", () => {
  let sandboxMock: any;
  let fsMock: any;
  let ctx: any;

  beforeEach(async () => {
    // EXTRA 必须真实存在:fs 侧包装与 bash 侧(bwrap/Landlock)一样只对
    // 当前存在的目录生效(两侧对齐,不再放行缺失根);Seatbelt 不受限。
    mkdirSync(EXTRA, { recursive: true });
    sandboxMock = makeSandboxMock();
    fsMock = makeFsMock();
    ctx = makeCtx(sandboxMock, fsMock);
    await apply(ctx, { extraWritableRoots: [EXTRA] });
  });

  afterEach(() => {
    rmSync(EXTRA, { recursive: true, force: true });
  });

  it("seatbelt 额外目录+官方根", async () => {
    const out = await sandboxMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
    expect(out.argv[2]).toContain('(subpath "' + canonicalPath(EXTRA) + '")');
    expect(out.argv[2]).toContain('(subpath "/ws")');
  });

  it("fs fence 放行额外根目录", async () => {
    const granted = await fsMock.checkedTarget({ displayPath: EXTRA + "/foo" });
    expect(granted.targetKey).toBe(EXTRA + "/foo");
  });

  it("fs fence 仍拒绝非额外路径", async () => {
    await expect(fsMock.checkedTarget({ displayPath: "/tmp/other/bar" })).rejects.toThrow("FS_SANDBOX_DENIED");
  });

  it("remote set 热更新", async () => {
    ctx.gateway.set({ extraWritableRoots: ["/tmp/hot"] });
    const out2 = await sandboxMock.confine(["x"], { mode: "workspace-write", workspaceRoot: WS });
    expect(out2.argv[2].includes('(subpath "/tmp/hot")')).toBe(true);
  });

  it("confine 异步化：包装返回 Promise 并把 signal 透传给原实现", async () => {
    const signal = new AbortController().signal;
    const out = await sandboxMock.confine(["bash"], { mode: "workspace-write", workspaceRoot: WS }, signal);
    expect(out.argv[0]).toBe("sandbox-exec");
    expect(sandboxMock.lastSignal).toBe(signal);
  });

  it("remote 拒绝相对路径", () => {
    expect(() => ctx.gateway.set({ extraWritableRoots: ["relative/path"] })).toThrow(/absolute path/);
  });
});

describe("sandbox-extra-roots host (bwrap)", () => {
  it("bwrap 只授予存在的额外目录", async () => {
    const fakeHome2 = mkdtempSync(join(tmpdir(), "ser-fh2-"));
    const existingExtra = mkdtempSync(join(tmpdir(), "ser-existing-"));
    const missingExtra = join(fakeHome2, "missing-root");
    process.env.HOME = fakeHome2;
    process.env.DSH_HOME = fakeHome2;
    try {
      const bwrapMock = {
        async confine(argv: string[], policy: any) {
          return { argv: ["bwrap", "--ro-bind", "/", "/", "--", ...argv], enforcement: "full", denialSignatures: [], runnerFailureRules: [] };
        },
      };
      const fsMock = makeFsMock();
      const ctx = makeCtx(bwrapMock, fsMock);
      await apply(ctx, { extraWritableRoots: [missingExtra, existingExtra] });
      const bwrapOut = await bwrapMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
      const bindArgs = bwrapOut.argv.slice(0, bwrapOut.argv.indexOf("--"));
      const canonicalExistingExtra = canonicalPath(existingExtra);
      const canonicalMissingExtra = canonicalPath(missingExtra);
      expect(bindArgs).toContain("--bind");
      expect(bindArgs).toContain(canonicalExistingExtra);
      expect(bindArgs).not.toContain(canonicalMissingExtra);
    } finally {
      process.env.HOME = fakeHome;
      process.env.DSH_HOME = fakeHome;
      rmSync(fakeHome2, { recursive: true, force: true });
      rmSync(existingExtra, { recursive: true, force: true });
    }
  });
});

describe("sandbox-extra-roots 运行期符号链接重定向(逃逸防护)", () => {
  // 攻击模型:extra root 位于沙盒可写区(如 /tmp),沙盒内的 agent 把它
  // 替换成指向危险根的符号链接;confine/fs fence 每次调用重新 canonical
  // 化会跟随新目标,必须在授予前复查并剔除,否则等价于全盘可写。
  function swapToSymlink(root: string, target: string) {
    rmSync(root, { recursive: true, force: true });
    symlinkSync(target, root, "dir");
  }

  it("extra root 被换成指向 / 的符号链接后,bash profile 与 fs fence 都不授予", async () => {
    const base = mkdtempSync(join(tmpdir(), "ser-swap-"));
    const root = join(base, "cache");
    mkdirSync(root, { recursive: true });
    const sandboxMock = makeSandboxMock();
    const fsMock = makeFsMock();
    const ctx = makeCtx(sandboxMock, fsMock);
    try {
      await apply(ctx, { extraWritableRoots: [root] });
      // 配置期目录真实存在,正常授予(前置确认,排除假阳性)
      expect((await sandboxMock.confine(["bash"], { mode: "workspace-write", workspaceRoot: WS })).argv[2])
        .toContain(`(subpath "${canonicalPath(root)}")`);

      swapToSymlink(root, "/");
      const out = await sandboxMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
      expect(out.argv[2]).not.toContain('(subpath "/")');
      // fs 侧同样不得放行(指向 / 后全盘都会命中该根)
      await expect(fsMock.checkedTarget({ displayPath: "/etc/hosts" })).rejects.toThrow("FS_SANDBOX_DENIED");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("extra root 被换成指向用户主目录的符号链接后同样被剔除", async () => {
    const base = mkdtempSync(join(tmpdir(), "ser-swap2-"));
    const root = join(base, "cache");
    mkdirSync(root, { recursive: true });
    const sandboxMock = makeSandboxMock();
    const fsMock = makeFsMock();
    const ctx = makeCtx(sandboxMock, fsMock);
    try {
      await apply(ctx, { extraWritableRoots: [root] });
      swapToSymlink(root, fakeHome);
      const out = await sandboxMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
      expect(out.argv[2]).not.toContain(`(subpath "${canonicalPath(fakeHome)}")`);
      await expect(fsMock.checkedTarget({ displayPath: fakeHome + "/secret" })).rejects.toThrow("FS_SANDBOX_DENIED");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("bwrap 侧同样剔除重定向后的危险根", async () => {
    const base = mkdtempSync(join(tmpdir(), "ser-swap3-"));
    const root = join(base, "cache");
    mkdirSync(root, { recursive: true });
    const bwrapMock = {
      confine(argv: string[], policy: any) {
        return { argv: ["bwrap", "--ro-bind", "/", "/", "--", ...argv], enforcement: "full", denialSignatures: [], runnerFailureRules: [] };
      },
    };
    const ctx = makeCtx(bwrapMock, makeFsMock());
    try {
      await apply(ctx, { extraWritableRoots: [root] });
      swapToSymlink(root, "/");
      const out = await bwrapMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
      const bindArgs = out.argv.slice(0, out.argv.indexOf("--"));
      // 不出现 "--bind / /"
      expect(bindArgs).not.toContain("--bind");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("sandbox-extra-roots 危险根校验", () => {
  it("remote set 拒绝根路径与用户主目录本身", async () => {
    const sandboxMock = makeSandboxMock();
    const ctx = makeCtx(sandboxMock, makeFsMock());
    await apply(ctx, { extraWritableRoots: [] });
    expect(() => ctx.gateway.set({ extraWritableRoots: ["/"] })).toThrow(/dangerous/);
    expect(() => ctx.gateway.set({ extraWritableRoots: [fakeHome] })).toThrow(/dangerous/);
  });

  it("危险根的词法祖先被拒绝,后代仍允许(祖先判定回归)", async () => {
    // home 的父目录(如 macOS /Users、Linux /home;测试环境为 tmpdir 下
    // mkdtemp 的父目录)是 homedir 的祖先,授予它等于放开整个 home 区 →
    // 拒绝。断言全部用运行时取值(dirname/canonicalPath),不写死任何
    // 平台拼写,macOS(/var/... → /private/var/... canonical 化)与 Linux
    // (/tmp 直拼)都成立。
    const sandboxMock = makeSandboxMock();
    const ctx = makeCtx(sandboxMock, makeFsMock());
    await apply(ctx, { extraWritableRoots: [] });
    const homeParent = dirname(fakeHome);
    expect(() => ctx.gateway.set({ extraWritableRoots: [homeParent] })).toThrow(/dangerous/);
    // 危险根的后代比危险根更窄,授予仍然安全:home 下的子目录照常接受。
    const nested = join(fakeHome, "cache");
    mkdirSync(nested, { recursive: true });
    expect(() => ctx.gateway.set({ extraWritableRoots: [nested] })).not.toThrow();
    // 授予确实生效(不是被静默丢弃):confine 里的拼写是 canonicalPath 的
    // 产物,断言用同一函数取值,跨平台对齐。
    const out = await sandboxMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
    expect(out.argv[2]).toContain('(subpath "' + canonicalPath(nested) + '")');
  });

  // /private 是 macOS 的 canonical 前缀拼写;该平台差异用例显式 skipIf,
  // 其他平台跳过而非空跑/失败。
  it.skipIf(process.platform !== "darwin")("macOS:系统目录的 canonical 前缀(/private)被 normalize 过滤", async () => {
    const sandboxMock = makeSandboxMock();
    const ctx = makeCtx(sandboxMock, makeFsMock());
    // /private 本身不在系统目录名单上,但它是 /private/etc 等 canonical
    // 系统目录的词法祖先,授予它等价于授予系统目录 → filter 剔除。
    await apply(ctx, { extraWritableRoots: ["/private"] });
    const out = await sandboxMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
    expect(out.argv[2]).not.toContain('(subpath "/private")');
  });

  it("patch/YAML 配置里的系统目录被 normalize 过滤(绕过 remote.set 也安全)", async () => {
    const sandboxMock = makeSandboxMock();
    const fsMock = makeFsMock();
    const ctx = makeCtx(sandboxMock, fsMock);
    await apply(ctx, { extraWritableRoots: ["/etc", "/usr"] });
    const out = await sandboxMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
    for (const spelling of ["/etc", "/usr", "/private/etc", "/private/usr"]) {
      expect(out.argv[2]).not.toContain('(subpath "' + spelling + '")');
    }
    // fs 侧同样不放行系统目录
    await expect(fsMock.checkedTarget({ displayPath: "/etc/hosts" })).rejects.toThrow("FS_SANDBOX_DENIED");
  });

  it("fs fence 与 bash 侧对齐:非目录 root 不再单侧放行", async () => {
    const filePath = join(fakeHome, "not-a-dir");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "x");
    const sandboxMock = makeSandboxMock();
    const fsMock = makeFsMock();
    const ctx = makeCtx(sandboxMock, fsMock);
    await apply(ctx, { extraWritableRoots: [filePath] });
    const out = await sandboxMock.confine(["bash"], { mode: "workspace-write", workspaceRoot: WS });
    expect(out.argv[2]).toContain('(subpath "' + canonicalPath(filePath) + '")'); // Seatbelt 不受限
    await expect(fsMock.checkedTarget({ displayPath: filePath })).rejects.toThrow("FS_SANDBOX_DENIED"); // fs 侧过滤
  });
});

describe("sandbox-extra-roots 卸载/重装回路", () => {
  it("dispose 还原原方法,再 apply 重新包装且功能正常", async () => {
    mkdirSync(EXTRA, { recursive: true });
    const sandboxMock = makeSandboxMock();
    const fsMock = makeFsMock();
    const origConfine = sandboxMock.confine;
    const origCheckedTarget = fsMock.checkedTarget;
    const ctx = makeCtx(sandboxMock, fsMock);
    const canonicalExtra = canonicalPath(EXTRA);
    try {
      // 第一次 apply:包装安装、功能生效
      await apply(ctx, { extraWritableRoots: [EXTRA] });
      expect(sandboxMock.confine).not.toBe(origConfine);
      expect(fsMock.checkedTarget).not.toBe(origCheckedTarget);
      const out = await sandboxMock.confine(["bash"], { mode: "workspace-write", workspaceRoot: WS });
      expect(out.argv[2]).toContain(`(subpath "${canonicalExtra}")`);
      await expect(fsMock.checkedTarget({ displayPath: EXTRA + "/f" })).resolves.toMatchObject({ targetKey: EXTRA + "/f" });

      // 卸载:原方法逐字还原,包装行为消失
      ctx.disposeAll();
      expect(sandboxMock.confine).toBe(origConfine);
      expect(fsMock.checkedTarget).toBe(origCheckedTarget);
      await expect(fsMock.checkedTarget({ displayPath: EXTRA + "/f" })).rejects.toThrow("FS_SANDBOX_DENIED");

      // 再 apply:重新包装,功能恢复;再卸载仍然干净
      await apply(ctx, { extraWritableRoots: [EXTRA] });
      expect(sandboxMock.confine).not.toBe(origConfine);
      expect(fsMock.checkedTarget).not.toBe(origCheckedTarget);
      const out2 = await sandboxMock.confine(["bash"], { mode: "workspace-write", workspaceRoot: WS });
      expect(out2.argv[2]).toContain(`(subpath "${canonicalExtra}")`);
      await expect(fsMock.checkedTarget({ displayPath: EXTRA + "/f" })).resolves.toMatchObject({ targetKey: EXTRA + "/f" });
      ctx.disposeAll();
      expect(sandboxMock.confine).toBe(origConfine);
      expect(fsMock.checkedTarget).toBe(origCheckedTarget);
    } finally {
      rmSync(EXTRA, { recursive: true, force: true });
    }
  });
});

describe("sandbox-extra-roots 漂移自检 fail-closed", () => {
  it("官方 profile 形状漂移时放弃重建,保持官方 argv(bash 侧额外根失效,fs 侧不受影响)", async () => {
    // 回归:漂移自检曾是 warn-only——检出官方 profile 形状变化后仍用本
    // 插件可能过时的模板整体替换官方 profile,官方新增的限制项会被静默
    // 丢掉(fail-open)。现在必须保持官方 argv 原样,告警注明 bash 侧失效。
    mkdirSync(EXTRA, { recursive: true });
    const driftedMock = {
      async confine(argv: string[], policy: any) {
        const roots = writableRoots(policy);
        // 模拟宿主升级后官方模板新增了限制项。
        return { argv: ["sandbox-exec", "-p", sbpl(roots) + " (deny network*)", "--", ...argv], enforcement: "full", denialSignatures: [], runnerFailureRules: [] };
      },
    };
    const fsMock = makeFsMock();
    const warnings: string[] = [];
    const ctx = makeCtx(driftedMock, fsMock);
    ctx.logger.warn = (message: string) => warnings.push(message);
    try {
      await apply(ctx, { extraWritableRoots: [EXTRA] });
      const out = await driftedMock.confine(["bash", "-c", "x"], { mode: "workspace-write", workspaceRoot: WS });
      // 官方 argv 原样保留:官方新增的限制项还在,额外根没有被注入。
      expect(out.argv[2]).toContain("(deny network*)");
      expect(out.argv[2]).not.toContain('(subpath "' + canonicalPath(EXTRA) + '")');
      expect(warnings.some((w) => w.includes("refusing to rebuild"))).toBe(true);
      // fs 侧放行不受漂移影响。
      const granted = await fsMock.checkedTarget({ displayPath: EXTRA + "/foo" });
      expect(granted.targetKey).toBe(EXTRA + "/foo");
    } finally {
      rmSync(EXTRA, { recursive: true, force: true });
    }
  });

  it("fs 侧内部异常不外泄:resolve 抛错回落官方 FS_SANDBOX_DENIED", async () => {
    // 回归:0.4.11 修过解绑调用 TypeError 盖过官方拒绝文本,resolve 本身
    // 的异常(契约漂移、祖先链 EACCES)是同源残留,现在同样兜底 rethrow
    // 官方拒绝。
    mkdirSync(EXTRA, { recursive: true });
    const sandboxMock = makeSandboxMock();
    const fsMock = makeFsMock();
    fsMock.resolve = async () => {
      throw new Error("EACCES: ancestor unreachable");
    };
    const ctx = makeCtx(sandboxMock, fsMock);
    try {
      await apply(ctx, { extraWritableRoots: [EXTRA] });
      await expect(fsMock.checkedTarget({ displayPath: EXTRA + "/foo" })).rejects.toThrow("FS_SANDBOX_DENIED");
    } finally {
      rmSync(EXTRA, { recursive: true, force: true });
    }
  });
});