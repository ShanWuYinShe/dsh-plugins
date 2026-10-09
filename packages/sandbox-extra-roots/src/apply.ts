/**
 * apply.ts — 插件主体：包装 sandbox/fs 的 confine 与 checkedTarget 并接配置热更新。
 *
 * 2026-10-08 从 545 行的 src/index.ts 拆出：配置、根目录判定、landlock 解析、
 * 网关与 apply 各自成模块，入口只保留 name/inject 与 re-export。
 *
 * @module @chaoset/sandbox-extra-roots/apply
 */

import { statSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isPathUnder, sandboxAvailable, seatbeltProfileArgs } from './common.js'
import { markLegacyImported, readLegacyConfig, resolveConfigPersist } from './config-store.js'
import { PluginConfigGateway } from './gateway.js'
import { name, DEFAULT_CONFIG, config } from './plugin-config.js'
import { STATE, ORIGINAL, canon, expandTilde, classifyRoot, extraGrantRoots } from './roots.js'
import { getLandlockExec } from './landlock-exec.js'
import { clearDirExistCache, existingDirectoryRoots } from './roots-filter.js'
import { normalizeRoots } from './config-validate.js'

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
      checkedProfile: false,
      profileDrifted: false
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

    // 生效配置:defaults 与 cordis 注入的 patch config（含 profile patch 里的
    // 用户 override——设置页保存经官方 configEditor 写入,由 Loader 对账后
    // reload 本行使新配置在这里生效）。热更新即行 reload:目录存在性缓存
    // 在每次 apply 重建时整体失效,保证按真实文件系统判定。
    const warn = (message: string) => ctx.logger?.warn?.(message);

    const cfg = { ...DEFAULT_CONFIG, ...patchConfig };

    // 旧版 config.json（0.4.x 自建目录）一次性迁移进 profile patch;后台执行,
    // 不阻塞激活。写入成功才把旧文件改名 *.imported;config-editor 不可用时
    // 保留旧文件,下次启动重试。
    void (async () => {
      const legacy = readLegacyConfig(name);
      if (legacy === undefined) return;
      const persist = resolveConfigPersist(ctx);
      if (persist === undefined) {
        ctx.logger?.warn?.("sandbox-extra-roots: config-editor unavailable; legacy config.json kept for a later migration");
        return;
      }
      try {
        await persist.edit(() => ({ ...DEFAULT_CONFIG, ...patchConfig, ...legacy }));
        markLegacyImported(name);
      } catch (error) {
        ctx.logger?.warn?.(`sandbox-extra-roots: legacy config migration failed (${(error as Error)?.message ?? String(error)}); will retry on next start`);
      }
    })();


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
    // 配置热更新（行 reload）后 apply 重跑,缓存整体失效,新配置立即按真实
    // 文件系统判定。

    // ── 前置:官方 dsh-sandbox 可用性检查 ──
    // 官方 dsh-sandbox 解析失败(包缺失/file:// 部署三个 profile anchor 都
    // 找不到)时降级为"插件不存在":跳过全部包装,只留一条高音量告警;
    // 绝不能让静态导入链的异常逃出 apply——那会拖垮 harness 启动。
    if (sandboxAvailable) {
      clearDirExistCache();
      sandboxState.extraRoots = normalizeRoots(cfg, warn);
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
        // confine 是异步实现（SandboxProvider.confine 返回 Promise，
        // terminal-bash 以 await + signal 调用）：包装必须同样是
        // async 并把 signal 透传给原实现，否则 wrapped 是 Promise、
        // wrapped.argv 为 undefined，每次 bash 执行都抛 TypeError。
        const installedConfine = async function confineWithExtraRoots(this: any, argv: any, policy: any, signal?: any) {
          const wrapped = await originalConfine.call(this, argv, policy, signal);
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
            // 漂移自检:官方 profile(空额外目录)应与本实现重建结果一致。检出
            // 漂移后**放弃重建**、保持官方 argv 原样(fail-closed)——用本插件
            // 可能过时的模板整体替换官方 profile,若官方新增了限制项会被静默
            // 丢掉,沙盒比官方更宽,这对安全敏感组件不可接受。bash 侧额外根
            // 随之失效(告警注明),fs 侧放行不受影响。
            if (!sandboxState.checkedProfile) {
              sandboxState.checkedProfile = true;
              try {
                const official = seatbeltProfileArgs(policy, []);
                if (official[1] !== a[2]) {
                  sandboxState.profileDrifted = true;
                  ctx.logger?.warn?.("sandbox-extra-roots: official seatbelt profile shape changed; refusing to rebuild it — bash-side extra roots stay OFF (the fs fence still grants them). Check common.ts seatbeltProfileArgs against dsh-sandbox-local.");
                }
              } catch {}
            }
            if (sandboxState.profileDrifted) return wrapped;
            // inner 命令从 -- 分隔符之后取,不硬编码下标:官方若在 -p 之前
            // 后追加参数,slice(3) 会静默错位。分隔符缺失(契约漂移)时不加
            // 额外根、保持官方 argv 原样(fail-safe,与 bwrap/Landlock 同策略)。
            const sbSep = a.indexOf("--");
            if (sbSep === -1) {
              warnOnce("seatbelt-separator", "seatbelt argv has no -- separator; cannot add extra writable roots");
              return wrapped;
            }
            // 分隔符不在期望位置(profile 后紧跟 --)同样是契约漂移:官方若在
            // profile 与 -- 之间新增参数,整表重建会把它静默丢掉,沙盒比官方
            // 更宽。与分隔符缺失同策略:放弃追加,保持官方 argv 原样。
            // 漂移自检只比对 profile 文本,检不出这种形态,必须在这里挡。
            if (sbSep !== 3) {
              warnOnce("seatbelt-separator-position", "seatbelt argv shape changed (args between profile and --); refusing to rebuild it — bash-side extra roots stay OFF (the fs fence still grants them)");
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
            for (const root of existingDirectoryRoots(extraGrantRoots(policy, roots), sandboxState.warned, "bwrap/Landlock", warn)) extra.push("--bind", root, root);
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
            for (const root of existingDirectoryRoots(extraGrantRoots(policy, roots), sandboxState.warned, "bwrap/Landlock", warn)) extra.push("--rw", root);
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
            // resolve 与后续匹配自身的异常(契约漂移如 displayPath 缺失、
            // canonical 化/祖先链 stat 遇 EACCES 等)同样不能外泄盖过官方
            // 拒绝——整体兜底 rethrow 原始 FS_SANDBOX_DENIED,失败姿态
            // 保持 fail-closed(方向与 0.4.11 的解绑调用防护一致)。
            try {
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
                "the fs fence",
                warn,
              );
              for (const root of roots) {
                if (await isPathUnder(fresh.targetKey, root)) return fresh;
              }
            } catch (innerError) {
              if (innerError === error) throw error;
              ctx.logger?.warn?.(`sandbox-extra-roots: fs-fence extra-root check failed (${(innerError as Error)?.message ?? String(innerError)}); keeping the official denial`);
              throw error;
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
        ctx.plugin(PluginConfigGateway, { config: cfg, serviceKey: "sandboxExtraRootsConfig" });
      } catch (error) {
        ctx.logger?.warn?.(`sandbox-extra-roots: settings gateway failed (core sandbox extension unaffected): ${(error as Error)?.message ?? String(error)}`);
      }
    }
    // 宿主已移除 settings namespace 注册体系（`settings.register` 不复
    // 存在）：卡片可见性改由 Loader profile entry 与
    // `plugins.bundle.config` slot 决定，卡片读写仍走上面的 config gateway。
    // 此处不做任何 settings 服务调用。
  } catch (error) {
    ctx.logger?.warn?.(`sandbox-extra-roots: init failed: ${(error as Error)?.message ?? String(error)}`);
  }
}
