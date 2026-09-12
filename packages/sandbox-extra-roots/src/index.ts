/**
 * sandbox-extra-roots — 沙盒额外允许目录插件（@chaoset/sandbox-extra-roots，host 层）
 *
 * 目标:在不修改全局安装、不替换任何配置行的情况下,给 dsh 沙盒的
 * workspace-write 模式增加"额外允许写入的目录"列表(工具缓存目录等)。
 *
 * 实现(包装服务实例方法,幂等、可卸载):
 *   1. 包装 ctx.sandbox(本地沙盒 provider 实例)的 confine:
 *      - Seatbelt(macOS):把官方 SBPL profile(工作区根 + /tmp + 平台
 *        临时目录)替换为"官方白名单 + 配置的额外目录"版本;
 *      - bwrap(Linux):在 "--" 分隔符前插入 "--bind <root> <root>"
 *        (bwrap 后挂载覆盖 "--ro-bind / /",等价于追加可写根);
 *      - Landlock(Linux):在 "--" 分隔符前插入 "--rw <root>";
 *      - Windows ACL runner:argv 层面无法追加额外根目录(官方 runner
 *        只认 --workspace/--temp/--write-sid),仅记录一次告警,
 *        bash 侧不生效(fs fence 侧仍生效)。
 *   2. 包装 ctx.fs(沙盒文件系统实例)的 checkedTarget:
 *      workspace-write 模式下,目标路径若落在额外目录内则放行(返回
 *      规范化后的 fresh target,与官方语义一致);否则委托原实现
 *      (保持官方的拒绝文本与 FS_SANDBOX_DENIED)。
 *   3. 幂等与热切换:共享状态挂在底层实例的私有 symbol 上,按"挂载点
 *      引用计数"管理——每次 apply 计数 +1(已包装则跳过安装,但配置
 *      刷新到共享状态,热更新立即生效);卸载时计数 -1,只有最后一个
 *      挂载点退出才还原。这样 loader 热切换(新 entry 先 apply、旧
 *      entry 后 dispose)时包装不会丢失。
 *
 * 官方白名单始终保留(workspace 根 + /tmp + 平台临时目录),额外目录只是追加。
 *
 * 配置:cordis.patch.yml 的 config 与
 *      ~/.dsh/plugins/sandbox-extra-roots/config.json(设置页 UI,权威)合并。
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { canonicalPath, isPathUnder, loadLandlock, sandboxAvailable, seatbeltProfileArgs, writableRoots } from "./common.js";
import { createConfigStore } from "./config-store.js";

// remote 服务（设置页 UI 的配置读写）可选：typert-protocol 不可用时
// 动态 import 失败，核心功能（沙盒包装）照常工作。
let PluginConfigGateway: any = null;
try {
  ({ PluginConfigGateway } = await import("./remote.js"));
} catch (error) {
  console.warn("sandbox-extra-roots: settings gateway unavailable: " + ((error as Error)?.message ?? String(error)));
}

// 宿主 settings 体系的 schema 库（dsh-settings 0.1.0-rc.7+ 用 schemastery）。
// DSH profile 的 hoisted node_modules 直接解析；仓库测试环境无此包时为
// null，settings namespace 注册段静默跳过（fail-safe）。
let Schema: any = null;
try {
  ({ default: Schema } = await import("@deepseek-ai/schemastery"));
} catch {}

export const name = "sandbox-extra-roots";

export const inject = ["sandbox", "fs", "sandboxPolicy"];

/** 默认配置。apply 时与 YAML 传入的 config 合并(cordis 不合并小写 config 导出)。 */
const DEFAULT_CONFIG = {
  extraWritableRoots: []
};

export const config = { ...DEFAULT_CONFIG };

/** 包装状态标记:挂在被包装的底层实例上,保证幂等与跨挂载点共享。 */
const STATE = Symbol("sandbox-extra-roots.state");
/** 取底层实例(sandbox/fs 通常就是 raw,防御性写法)。 */
const ORIGINAL = Symbol.for("cordis.original");

/** 以当前环境 canonical 化一个路径(dsh-sandbox 缺失时原样返回)。 */
function canon(path: string): string {
  return typeof canonicalPath === "function" ? canonicalPath(path) : path;
}

/** 展开 ~ 前缀为用户主目录（"~"、"~/"、"~\"），其余原样返回。
 * 设置页允许 ~ 拼写（用户最常见的缓存目录写法），host 在校验与
 * 规范化之前统一展开，保证 validate/normalize 两个入口看到同一路径。 */
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
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
function classifyRoot(canonical: string): "reject" | "filter" | null {
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

/** 官方白名单(writableRoots 可能因 dsh-sandbox 加载失败为 undefined;
 * 本函数只在 sandboxAvailable=true 的包装路径被调用,类型上仍做防御)。 */
function officialWritableRoots(policy: any): string[] {
  try {
    const roots = typeof writableRoots === "function" ? writableRoots(policy) : [];
    return Array.isArray(roots) ? roots : [];
  } catch {
    return [];
  }
}

/**
 * bwrap/Landlock 分支的插入集合:与 Seatbelt 相同的 [官方根 ∪ 额外根]
 * 去重合并,再减去官方 argv 已授予的官方根——官方参数不动,插入段只补
 * 差额,避免对同一根重复 --bind/--rw(与 Seatbelt 的整表重建语义对齐)。
 */
function extraGrantRoots(policy: any, roots: string[]): string[] {
  const official = officialWritableRoots(policy);
  const officialSet = new Set(official);
  return [...new Set([...official, ...roots])].filter((root) => !officialSet.has(root));
}

/** Landlock runner 可执行路径，惰性加载（仅 Linux 且真正进入 apply 时解析）。 */
let landlockExecPromise: Promise<string | null> | null = null;
function getLandlockExec(): Promise<string | null> | null {
  if (process.platform !== "linux") return null;
  landlockExecPromise ??= loadLandlock()
    .then((landlock) => landlock.launcherPath())
    .catch(() => null);
  return landlockExecPromise;
}

/** 把配置 namespace 注册进宿主 settings 体系（dsh-settings 0.1.0-rc.7+）。
 * 设置页 describe() 只枚举 settings.register 注册过的 namespace；本插件
 * 的卡片读写不经过宿主 settings 文档，注册只为让卡片出现在设置页。
 * options.base 必传当前生效配置快照：宿主 resolve = schema(mergeLayers(base,
 * section))，schema 无默认值时 base 缺失会让 describe() 的 value 为
 * undefined，而设置页 wire 校验要求 value 非空（invalid_type: nonoptional），
 * 一项失败会拖垮整个设置页。
 * fail-safe（schema 库/服务缺失静默跳过）+ 幂等（重复注册忽略）。
 * 导出以便测试注入 Schema stub。 */
export function registerSettingsNamespace(ctx: any, ns: string, schemaLib: any, buildSchema: (z: any) => any, options: any): boolean {
  if (schemaLib === null || schemaLib === undefined) return false;
  if (ctx === null || typeof ctx !== "object" || typeof ctx.inject !== "function") return false;
  try {
    ctx.inject(["settings"], (settingsCtx: any) => {
      try {
        settingsCtx.settings.register(ns, buildSchema(schemaLib), options);
      } catch (error) {
        const message = String((error as Error)?.message ?? String(error));
        if (!message.includes("already registered")) throw error;
      }
    });
    return true;
  } catch (error) {
    try { ctx.logger?.warn?.(`sandbox-extra-roots: settings namespace registration skipped: ${(error as Error)?.message ?? String(error)}`); } catch {}
    return false;
  }
}

export async function apply(ctx: Context, config?: any): Promise<void> {
  // fail-safe:初始化失败只记录,绝不让本插件拖垮 harness(host 层挂载时
  // entry 异常会导致进程启动失败)。
  try {
    const patchConfig = config || {};
    const rawSandbox = ctx.sandbox[ORIGINAL] ?? ctx.sandbox;
    const rawFs = ctx.fs[ORIGINAL] ?? ctx.fs;
    const landlockExec = await getLandlockExec();

    // 共享状态(跨挂载点):计数 + 包装句柄 + 当前生效的额外目录。
    const sandboxState = rawSandbox[STATE] ?? (rawSandbox[STATE] = {
      mounts: 0,
      extraRoots: [] as string[],
      installed: null,
      hadOwn: false,
      origConfine: null,
      wrapped: false,
      warned: new Set<string>(),
      checkedProfile: false
    });
    sandboxState.mounts += 1;

    const fsState = rawFs[STATE] ?? (rawFs[STATE] = {
      mounts: 0,
      extraRoots: [] as string[],
      installed: null,
      hadOwn: false,
      origCheckedTarget: null,
      wrapped: false,
      warned: new Set<string>()
    });
    fsState.mounts += 1;

    // 卸载计数:在继续初始化之前登记，后续 setup 失败也由本 fiber 负责递减。
    // 最后一次退出才还原包装。
    ctx.effect(() => () => {
      sandboxState.mounts -= 1;
      if (sandboxState.mounts <= 0) {
        if (sandboxState.wrapped && rawSandbox.confine === sandboxState.installed) {
          if (sandboxState.hadOwn) rawSandbox.confine = sandboxState.origConfine;
          else delete rawSandbox.confine;
        }
        sandboxState.installed = null;
        sandboxState.wrapped = false;
        sandboxState.extraRoots = [];
        try { delete rawSandbox[STATE]; } catch {}
      }
      fsState.mounts -= 1;
      if (fsState.mounts <= 0) {
        if (fsState.wrapped && rawFs.checkedTarget === fsState.installed) {
          if (fsState.hadOwn) rawFs.checkedTarget = fsState.origCheckedTarget;
          else delete rawFs.checkedTarget;
        }
        fsState.installed = null;
        fsState.wrapped = false;
        fsState.extraRoots = [];
        try { delete rawFs[STATE]; } catch {}
      }
    });

    // 配置存储:patch config 低优先级,config.json(设置页 UI)权威。
    // 热更新:onUpdate 里同步刷新两个 state 的 extraRoots。
    // （目录存在性缓存声明在 store 之前:onUpdate 回调引用它,不能让
    // 回调看到 TDZ 中的绑定——将来 createConfigStore 若在构造期同步调
    // onUpdate 会直接 ReferenceError。）
    const dirExistCache = new Map<string, { ok: boolean; until: number }>();
    const DIR_EXIST_TTL_MS = 5000;
    function isExistingDirCached(root: string): boolean {
      const now = Date.now();
      const hit = dirExistCache.get(root);
      if (hit !== undefined && hit.until > now) return hit.ok;
      let ok = false;
      try {
        ok = statSync(root, { throwIfNoEntry: false })?.isDirectory() === true;
      } catch {
        ok = false;
      }
      dirExistCache.set(root, { ok, until: now + DIR_EXIST_TTL_MS });
      return ok;
    }

    // bwrap/Landlock 的 --bind/--rw 与 fs fence 的包含判断都只对"当前真实
    // 存在的目录"生效:不存在的 root 会让 bwrap/Landlock 启动失败(Landlock
    // 契约里是 "unopenable grant root"),也会造成 bash 与 fs 两侧判定分叉,
    // 因此两侧共用这一个目录过滤器;同一侧同一根只告警一次(warned 复用)。
    function existingDirectoryRoots(roots: string[], warned: Set<string>, side: string) {
      const existing = [];
      for (const root of roots) {
        if (isExistingDirCached(root)) {
          existing.push(root);
          continue;
        }
        const key = `missing-root:${side}:${root}`;
        if (!warned.has(key)) {
          warned.add(key);
          ctx.logger?.warn?.(`sandbox-extra-roots: extra writable root does not exist or is not a directory; not granting it to ${side}: ${root}`);
        }
      }
      return existing;
    }
    const store = createConfigStore({
      name: "sandbox-extra-roots",
      defaults: DEFAULT_CONFIG,
      patchConfig,
      validate: validateSandboxConfig,
      warn: (message) => ctx.logger?.warn?.(`sandbox-extra-roots: ${message}`),
      onUpdate: (merged) => {
        sandboxState.extraRoots = normalizeRoots({ ...DEFAULT_CONFIG, ...patchConfig, ...merged });
        fsState.extraRoots = sandboxState.extraRoots;
        dirExistCache.clear(); // 新配置按真实文件系统立即判定，不沿用旧 TTL
      }
    });
    const cfg = store.effective();

    // remote.set 严格校验：非法数组/相对路径直接拒绝，UI 能立即看到原因。
    function validateSandboxConfig(partial: any) {
      if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
        throw new TypeError("sandbox-extra-roots config must be a plain object");
      }
      if (partial.extraWritableRoots !== void 0) {
        if (!Array.isArray(partial.extraWritableRoots)) {
          throw new TypeError('sandbox-extra-roots config field "extraWritableRoots" must be an array');
        }
        for (const rawRoot of partial.extraWritableRoots) {
          const root = typeof rawRoot === "string" ? expandTilde(rawRoot) : rawRoot;
          if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
            throw new TypeError(`sandbox-extra-roots: extra writable root must be a non-empty absolute path: ${JSON.stringify(root)}`);
          }
          // 危险根直接拒绝:canonical 后等于 "/"、Windows 盘根或用户主目录
          // 本身,授予它等于放弃整个沙盒边界。信息带原始值,UI 能看到原因。
          const canonical = canon(root);
          if (classifyRoot(canonical) === "reject") {
            throw new TypeError(`sandbox-extra-roots: refusing dangerous extra writable root ${JSON.stringify(root)} (resolves to ${canonical}); granting it would effectively disable the sandbox`);
          }
        }
      }
    }

    // 只接受绝对路径:相对路径/空值会破坏词法包含判断,直接拒绝并告警。
    // canonical 化后做危险根分类:reject 级("/"等)在此兜底过滤(patch/YAML
    // 不经过 remote.set 校验),filter 级系统目录 warn 后一并剔除。
    function normalizeRoots(c: any) {
      const roots = Array.isArray(c.extraWritableRoots) ? c.extraWritableRoots : [];
      if (!Array.isArray(c.extraWritableRoots)) {
        ctx.logger?.warn?.("sandbox-extra-roots: extraWritableRoots must be an array of absolute paths; ignoring current config");
      }
      const expanded = roots.map((root: any) => (typeof root === "string" ? expandTilde(root) : root));
      const normalized = expanded
        .filter((root: any) => {
          if (typeof root === "string" && root.length > 0 && isAbsolute(root)) return true;
          ctx.logger?.warn?.(`sandbox-extra-roots: ignoring non-absolute extra writable root ${JSON.stringify(root)}`);
          return false;
        })
        .map((root: any) => canon(root))
        .filter((canonical: string) => {
          const verdict = classifyRoot(canonical);
          if (verdict === null) return true;
          ctx.logger?.warn?.(verdict === "reject"
            ? `sandbox-extra-roots: ignoring dangerous extra writable root ${JSON.stringify(canonical)}; granting it would disable the sandbox boundary`
            : `sandbox-extra-roots: ignoring system directory ${JSON.stringify(canonical)} as extra writable root`);
          return false;
        });
      return [...new Set(normalized)];
    }

    // 运行期危险根复查:配置期的 classifyRoot 只看配置时刻的文件系统,而
    // confine 与 fs fence 每次调用都会重新 canonical 化并跟随符号链接。
    // 若 extra root 位于沙盒可写区,沙盒内的 agent 可以把它替换成指向
    // "/"、homedir 等危险根的符号链接——重新 canonical 化会得到危险根,
    // 不复查就等于给"跟随重定向"开了沙盒逃逸通道。因此每次调用对最新
    // canonical 结果重跑分类,reject/filter 一律剔除;同一侧同一根只告警
    // 一次(每次 confine 都会走到这里,不能按调用告警)。
    function safeRuntimeRoots(roots: string[], warned: Set<string>, side: string): string[] {
      const safe: string[] = [];
      for (const root of roots) {
        if (classifyRoot(root) === null) {
          safe.push(root);
          continue;
        }
        const key = `runtime-danger:${side}:${root}`;
        if (!warned.has(key)) {
          warned.add(key);
          ctx.logger?.warn?.(`sandbox-extra-roots: extra writable root now resolves to a dangerous root (symlink swap?); not granting it to ${side}: ${root}`);
        }
      }
      return safe;
    }

    // 目录存在性短 TTL 缓存：bwrap/Landlock 的每次 confine 与 fs fence 的每次
    // 拒绝复核都会按根逐个 statSync（同步 IO 落在 bash 启动热路径上）。目录的
    // 创建/删除是低频事件，TTL 内沿用上次结果；代价是新建目录最多延迟 TTL
    // 才被授予（对"配置了还不存在的目录，稍后创建"的场景可接受）。
    // 配置热更新时整体失效（onUpdate），保证新配置立即按真实文件系统判定。
    // （缓存本体声明在 apply 前段、store 创建之前——onUpdate 回调引用它。）

    // ── 前置:官方 dsh-sandbox 可用性检查 ──
    // 官方 dsh-sandbox 解析失败(包缺失/file:// 部署三个 profile anchor 都
    // 找不到)时降级为"插件不存在":跳过全部包装,只留一条高音量告警;
    // 绝不能让静态导入链的异常逃出 apply——那会拖垮 harness 启动。
    if (sandboxAvailable) {
      sandboxState.extraRoots = normalizeRoots(cfg);
      fsState.extraRoots = sandboxState.extraRoots;

      // ── 1a. 包装 bash 沙盒的 confine:按 runner 追加额外可写目录 ──
      if (!sandboxState.wrapped) {
        sandboxState.hadOwn = Object.hasOwn(rawSandbox, "confine");
        const originalConfine: any = rawSandbox.confine;
        if (sandboxState.hadOwn) sandboxState.origConfine = originalConfine;
        const warnOnce = (key: string, message: string) => {
          if (sandboxState.warned.has(key)) return;
          sandboxState.warned.add(key);
          ctx.logger?.warn?.(`sandbox-extra-roots: ${message}`);
        };
        const installedConfine = function confineWithExtraRoots(this: any, argv: any, policy: any) {
          const wrapped = originalConfine.call(this, argv, policy);
          if (policy?.mode !== "workspace-write") return wrapped;
          if (sandboxState.extraRoots.length === 0) return wrapped;
          // 每次调用重新 canonical 化(与官方 writableRoots 对 workspaceRoot
          // 的姿态一致):符号链接重定向后,下一次 confine 立即跟随新目标,
          // 不必等配置重新加载。跟随之后必须复查危险根:重定向目标可能是
          // "/"或 homedir(沙盒内符号链接交换),运行期一律剔除。
          const roots = safeRuntimeRoots(
            [...new Set<string>(sandboxState.extraRoots.map(canon))],
            sandboxState.warned,
            "bash commands",
          );
          const a = wrapped.argv;
          // Seatbelt:官方 argv 为 [sandbox-exec, -p, <profile>, --, ...inner]。
          if (a[1] === "-p" && typeof a[2] === "string" && a[2].includes("(version 1)")) {
            // 漂移自检:官方 profile(空额外目录)应与本实现重建结果一致。
            if (!sandboxState.checkedProfile) {
              sandboxState.checkedProfile = true;
              try {
                const official = seatbeltProfileArgs(policy, []);
                if (official[1] !== a[2]) {
                  ctx.logger?.warn?.("sandbox-extra-roots: official seatbelt profile shape changed; plugin may be stale (check common.ts seatbeltProfileArgs against dsh-sandbox-local)");
                }
              } catch {}
            }
            // inner 命令从 -- 分隔符之后取,不硬编码下标:官方若在 -p 之前
            // 后追加参数,slice(3) 会静默错位。分隔符缺失(契约漂移)时不加
            // 额外根、保持官方 argv 原样(fail-safe,与 bwrap/Landlock 同策略)。
            const sbSep = a.indexOf("--");
            if (sbSep === -1) {
              warnOnce("seatbelt-separator", "seatbelt argv has no -- separator; cannot add extra writable roots");
              return wrapped;
            }
            wrapped.argv = [a[0], ...seatbeltProfileArgs(policy, roots), ...a.slice(sbSep + 1)];
            return wrapped;
          }
          // bwrap:在 -- 前插入 --bind <root> <root>(后挂载覆盖 --ro-bind / /)。
          // 插入集合与 Seatbelt 对齐:官方根 ∪ 额外根去重后减去官方已授予的
          // 部分;且只授予当前真实存在的目录,缺失 root 会让 bwrap 启动失败。
          if (a[0] === "bwrap") {
            const sep = a.indexOf("--");
            if (sep === -1) {
              warnOnce("bwrap-separator", "bwrap argv has no -- separator; cannot add extra writable roots");
              return wrapped;
            }
            const extra = [];
            for (const root of existingDirectoryRoots(extraGrantRoots(policy, roots), sandboxState.warned, "bwrap/Landlock")) extra.push("--bind", root, root);
            wrapped.argv = [...a.slice(0, sep), ...extra, ...a.slice(sep)];
            return wrapped;
          }
          // Landlock:在 -- 前插入 --rw <root>(runner 原生参数)。
          // 与 bwrap 同一插入集合;同样只授予存在的目录（launcher 把
          // unopenable grant root 视为失败）。
          if (landlockExec !== null && a[0] === landlockExec) {
            const sep = a.indexOf("--");
            if (sep === -1) {
              warnOnce("landlock-separator", "landlock argv has no -- separator; cannot add extra writable roots");
              return wrapped;
            }
            const extra = [];
            for (const root of existingDirectoryRoots(extraGrantRoots(policy, roots), sandboxState.warned, "bwrap/Landlock")) extra.push("--rw", root);
            wrapped.argv = [...a.slice(0, sep), ...extra, ...a.slice(sep)];
            return wrapped;
          }
          // Windows ACL runner:argv 层面无法追加额外根目录,仅告警一次。
          // 只检查 runner 参数段（-- 之前），避免误匹配用户命令里的 --workspace。
          const runnerArgs = a.slice(0, a.indexOf("--") === -1 ? a.length : a.indexOf("--"));
          if (runnerArgs.includes("--workspace")) {
            warnOnce("windows-acl", "windows-acl runner cannot grant extra writable roots; bash-side extra roots are not granted on Windows (the fs fence still grants them)");
            return wrapped;
          }
          warnOnce(`unknown-runner:${a[0]}`, `unknown sandbox runner argv[0] "${a[0]}"; bash-side extra writable roots are not granted`);
          return wrapped;
        };
        rawSandbox.confine = installedConfine;
        sandboxState.installed = installedConfine;
        sandboxState.wrapped = true;
      }

      // ── 1b. 包装文件系统 fence 的 checkedTarget:额外目录放行 ──
      if (!fsState.wrapped) {
        fsState.hadOwn = Object.hasOwn(rawFs, "checkedTarget");
        const originalCheckedTarget: any = rawFs.checkedTarget;
        if (fsState.hadOwn) fsState.origCheckedTarget = originalCheckedTarget;
        const installedCheckedTarget = async function checkedTargetWithExtraRoots(this: any, target: any, sandboxPolicy: any) {
          try {
            return await originalCheckedTarget.call(this, target, sandboxPolicy);
          } catch (error) {
            // 官方白名单拒绝后，再检查是否落在本插件配置的额外根目录内。
            // 这样官方逻辑永远优先执行，后续 DSH 升级也不会因复制实现而漂移。
            if ((error as NodeJS.ErrnoException)?.code !== "FS_SANDBOX_DENIED") throw error;
            // 宿主契约:sandboxPolicy.resolve() 同步返回普通对象(见 dsh.d.ts)。
            // 这里不能 await——若宿主未来异步化,policy.mode 会是 undefined,
            // 恒走 rethrow 分支,fs 侧额外目录将静默失效;升级时核对该签名。
            // 策略解析本身失败(服务缺失/契约变化)时保持官方拒绝语义:rethrow
            // 原始 FS_SANDBOX_DENIED,绝不让插件内部异常盖过沙盒拒绝。
            let policy: any;
            try {
              policy = sandboxPolicy ?? ctx.sandboxPolicy.resolve();
            } catch {
              throw error;
            }
            if (policy?.mode !== "workspace-write") throw error;
            // 显式绑定到底层实例:宿主若以解绑形式调用 checkedTarget
            // (const ct = fs.checkedTarget; ct(...)),this.resolve 会是
            // undefined 并抛 TypeError,把官方的 FS_SANDBOX_DENIED 拒绝
            // 文本替换成插件内部异常。
            const fresh = await rawFs.resolve.call(rawFs, target.displayPath);
            // 与 bash 侧(bwrap/Landlock)对齐:只对当前真实存在的目录放行,
            // 消除"文件工具放行、bash 拒绝"或反向的分叉;每次调用重新
            // canonical 化,符号链接重定向后立即跟随(同 confine 路径)。
            // 跟随之后同样复查危险根(bash 侧 safeRuntimeRoots 的镜像,
            // 沙盒内符号链接交换不能让 fs 侧单侧放行全盘)。
            const roots = existingDirectoryRoots(
              safeRuntimeRoots(
                [...new Set<string>(fsState.extraRoots.map(canon))],
                fsState.warned,
                "the fs fence",
              ),
              fsState.warned,
              "the fs fence"
            );
            for (const root of roots) {
              if (await isPathUnder(fresh.targetKey, root)) return fresh;
            }
            throw error;
          }
        };
        rawFs.checkedTarget = installedCheckedTarget;
        fsState.installed = installedCheckedTarget;
        fsState.wrapped = true;
      }
    } else {
      ctx.logger?.warn?.("sandbox-extra-roots: @deepseek-ai/dsh-sandbox unavailable; plugin degraded to no-op, sandbox NOT extended");
    }

    // ── 3. 可选服务(设置页 UI):排在核心包装之后,且各自独立 fail-safe——
    // gateway 失败不影响包装,包装失败也不影响 gateway。 ──
    // 远程配置服务(设置页 UI 读写；typert 不可用时 PluginConfigGateway 为 null)
    if (PluginConfigGateway !== null) {
      try {
        ctx.plugin(PluginConfigGateway, { store, serviceKey: "sandboxExtraRootsConfig" });
      } catch (error) {
        ctx.logger?.warn?.(`sandbox-extra-roots: settings gateway failed (core sandbox extension unaffected): ${(error as Error)?.message ?? String(error)}`);
      }
    }
    try {
      // 注册进宿主 settings 体系(可见性)：设置页用 settings.describe() 枚举
      // registrations，未注册的 namespace 即使卡片带正确的 key 也不渲染。
      // 卡片的实际读写仍走 config gateway(config.json 权威、热更新)。
      // namespace 必须匹配宿主 ^[a-z][a-z0-9-]*$——驼峰会被 register() 抛
      // TypeError、inject 回调失败被静默吞掉，设置页遂不渲染卡片。
      registerSettingsNamespace(ctx, "sandbox-extra-roots-config", Schema, (z) => z.object({
        extraWritableRoots: z.array(z.string()).default([]),
      }), { base: cfg });
    } catch (error) {
      ctx.logger?.warn?.(`sandbox-extra-roots: settings namespace registration failed (core sandbox extension unaffected): ${(error as Error)?.message ?? String(error)}`);
    }
  } catch (error) {
    ctx.logger?.warn?.(`sandbox-extra-roots: init failed: ${(error as Error)?.message ?? String(error)}`);
  }
}