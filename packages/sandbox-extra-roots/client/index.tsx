import * as React from "react";
import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

var css = ".ser_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;min-width:0;overflow:hidden;transition:border-color .15s ease,box-shadow .15s ease}.ser_card[data-open=true]{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1)}.ser_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:12px 14px;display:flex;transition:background-color .15s ease}.ser_header:hover,.ser_card[data-open=true]>.ser_header{background:var(--dsw-alias-interactive-bg-hover)}.ser_title{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px}.ser_badge{white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#faad14) 14%,transparent);color:var(--dsw-alias-state-warn-primary,#faad14);border-radius:999px;padding:2px 8px;font-size:11px;font-weight:600;line-height:16px}.ser_body{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);padding:12px 14px 14px}.ser_field{flex-direction:column;gap:6px;padding:8px 0;display:flex}.ser_label{font-size:12px;font-weight:500;line-height:18px}.ser_textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:12px;line-height:18px;resize:vertical;min-height:120px;font-family:var(--ds-font-family-code,monospace);transition:border-color .15s ease,box-shadow .15s ease}.ser_textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#1677ff);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#1677ff) 20%,transparent)}.ser_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:16px}.ser_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:10px 0 2px;display:flex}.ser_save{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:6px;padding:5px 16px;font-size:12px;font-weight:500;line-height:18px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);transition:all .15s ease}.ser_save:hover:not(:disabled){filter:brightness(1.1)}.ser_save:disabled{opacity:.4;cursor:default}.ser_discard{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary,#666);border-radius:6px;padding:5px 16px;font-size:12px;line-height:18px;transition:all .15s ease}.ser_discard:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.ser_discard:disabled{opacity:.4;cursor:default}.ser_status{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.ser_warn{color:var(--dsw-alias-state-warn-primary)}.ser_danger{color:var(--dsw-alias-state-error-primary)}.ser_info{color:var(--dsw-alias-label-tertiary)}.ser_error{color:var(--dsw-alias-state-error-primary);margin:8px 0 0}.ser_spin{flex:none;width:10px;height:10px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:ser-spin .8s linear infinite}@keyframes ser-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.ser_spin{animation:none}}";

    var tagId = "@chaoset/sandbox-extra-roots/client.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "@chaoset/sandbox-extra-roots";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const NS = "settings.plugins.sandboxExtraRoots";
    // web profile 与 host 同机运行,用 UA 近似平台(拿不到 host 的 homedir)。
    var ua = typeof navigator !== "undefined" ? String(navigator.userAgent || navigator.platform || "") : "";
    var isDarwin = /Mac/i.test(ua);
    var isWindows = /Win/i.test(ua);
    // 与 host classifyRoot 的过滤口径保持一致的客户端预览（词法级）：
    // 让"会被静默丢弃的行"在保存前就可见，而不是保存后只看到"已保存"。
    const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin"];
    // darwin 下系统目录的 realpath 拼写(/etc → /private/etc):/private 是
    // 这些目录的词法祖先,host 判为 filter 级静默剔除——预览若只比字面
    // 会漏掉用户最常见的 macOS 拼写。
    const DARWIN_SYSTEM_REALPATHS = ["/private/etc", "/private/usr", "/private/bin", "/private/sbin"];
    // 主目录的词法祖先是 reject 级(host 拒绝保存),典型拼写按平台近似:
    // darwin 在 /Users/<name>,Linux 在 /home/<name>,Windows 在 C:\Users\<name>。
    // host 按 homedir 精确判定;客户端只标这些常见祖先,宁可少标(交给 host
    // 拒绝),不误标合法路径。
    const HOME_ANCESTORS = isDarwin ? ["/users"] : isWindows ? ["c:/users"] : ["/home"];
    function isDirPrefix(prefix: string, path: string): boolean {
      if (prefix === "" || path === "") return false;
      return (path + "/").startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
    }
    function analyzeRootsText(text: string) {
      const problems: Array<{ line: number; kind: string; value: string }> = [];
      const seen = new Set<string>();
      text.split("\n").forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (line.length === 0) return;
        // ~/x：host 保存时展开为用户主目录下的子路径，客户端无法解析 home，
        // 视为合法。裸 ~ 是主目录本身——host 按 homedir 判 reject 拒绝保存，
        // 预览同样标 danger。
        if (line === "~") {
          problems.push({ line: index + 1, kind: "danger", value: line });
          return;
        }
        if (line.startsWith("~/") || line.startsWith("~\\")) return;
        const isAbsoluteLike = line.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(line);
        if (!isAbsoluteLike) {
          problems.push({ line: index + 1, kind: "invalid", value: line });
          return;
        }
        const normalized = line.replace(/[\\/]+$/, "") || "/";
        if (seen.has(normalized)) {
          problems.push({ line: index + 1, kind: "duplicate", value: line });
          return;
        }
        seen.add(normalized);
        const cmp = normalized.replace(/\\/g, "/").toLowerCase();
        if (normalized === "/" || /^[a-zA-Z]:[\\/]?$/.test(normalized)) {
          problems.push({ line: index + 1, kind: "danger", value: line });
        } else if (HOME_ANCESTORS.includes(cmp)) {
          problems.push({ line: index + 1, kind: "homeAncestor", value: line });
        } else if ([...SYSTEM_DIRS, ...(isDarwin ? DARWIN_SYSTEM_REALPATHS : [])].some((dir) => {
          const d = dir.toLowerCase();
          return cmp === d || isDirPrefix(cmp, d);
        })) {
          problems.push({ line: index + 1, kind: "system", value: line });
        }
      });
      return problems;
    }
    // host 必然拒绝的行(invalid/danger/homeAncestor)存在时禁用保存:与其让
    // 用户点了保存再读一段英文 TypeError,不如按钮禁用+行内原因。判据具名导出，
    // 保存按钮与单测共用同一条，避免两边各写一份而漂移。
    function hasBlockingProblems(problems: Array<{ kind: string }>): boolean {
      return problems.some((p) => p.kind === "invalid" || p.kind === "danger" || p.kind === "homeAncestor");
    }
    // 一键添加的常用工具缓存预设：各工具开箱默认路径（均可被环境变量覆盖，
    // 不适用直接改文本）。只收录“写缓存、不含凭证”的目录：含明文凭证的
    // （~/.docker、~/.ssh、~/.aws 等）永不进预设。点选即显式 opt-in——用户
    // 对亲手加入的负责；解除沙盒边界的条目（/、主目录等）仍会被保存
    // 判据拒绝，不在责任口径内。
    type RootPresetPlatform = "darwin" | "linux" | "win32";
    interface RootPreset { path: string; platforms: RootPresetPlatform[]; }
    const ROOT_PRESETS: RootPreset[] = [
      { path: "~/.npm", platforms: ["darwin", "linux"] },
      { path: "~/.cache/pip", platforms: ["linux"] },
      { path: "~/Library/Caches/pip", platforms: ["darwin"] },
      { path: "~/.cargo", platforms: ["darwin", "linux", "win32"] },
      { path: "~/go/pkg/mod", platforms: ["darwin", "linux", "win32"] },
    ];
    function presetsForPlatform(isDarwin: boolean, isWindows: boolean): string[] {
      const platform: RootPresetPlatform = isDarwin ? "darwin" : isWindows ? "win32" : "linux";
      return ROOT_PRESETS.filter((preset) => preset.platforms.includes(platform)).map((preset) => preset.path);
    }
    // chip 点击的纯拼接：已存在（去首尾空格比对）则原样返回，避免 duplicate
    // 预览对“一键添加”误报；否则另起一行追加并补换行，光标行保持可继续输入。
    function appendRootLine(draft: string | null, path: string): string | null {
      if (draft === null) return null;
      if (draft.split("\n").some((line) => line.trim() === path)) return draft;
      const trimmedEnd = draft.replace(/\s+$/, "");
      return (trimmedEnd.length === 0 ? "" : trimmedEnd + "\n") + path + "\n";
    }
    const zh = {
      title: "沙盒额外允许目录（sandbox-extra-roots）",
      summary: "为 workspace-write 沙箱追加可写目录（在官方白名单之外）",
      hint: "workspace-write 模式下，除官方白名单（工作区根 + /tmp + 平台临时目录）外额外允许写入的目录。每行一个绝对路径，支持 ~ 表示用户主目录。",
      unsaved: "有未保存的修改",
      discard: "放弃修改",
      saving: "保存中…",
      save: "保存",
      saveFailed: "保存失败",
      saved: "已保存，下次沙盒调用生效",
      loadFailed: "读取配置失败",
      loading: "加载中…",
      roots: "额外可写目录（每行一个绝对路径，支持 ~）",
      presetsTitle: "常用工具缓存（一键添加）：",
      placeholder: "~/data\n/tmp/cache",
      rootInvalid: "第 {n} 行「{v}」不是绝对路径，保存将被拒绝",
      rootDuplicate: "第 {n} 行「{v}」与前面的行重复（host 会去重）",
      rootDanger: "第 {n} 行「{v}」会被拒绝：授予它等于解除沙盒边界",
      rootHomeAncestor: "第 {n} 行「{v}」会被拒绝：它是主目录的父目录",
      rootSystem: "第 {n} 行「{v}」会被忽略：系统目录"
    };
    const en = {
      title: "Extra sandbox roots (sandbox-extra-roots)",
      summary: "Extra writable roots for the workspace-write sandbox, beyond the official allow-list",
      hint: "Extra writable roots under workspace-write mode, on top of the official allow-list (workspace root + /tmp + platform temp dirs). One absolute path per line; ~ expands to your home directory.",
      unsaved: "Unsaved changes",
      discard: "Discard",
      saving: "Saving…",
      save: "Save",
      saveFailed: "Save failed",
      saved: "Saved; takes effect on the next sandbox call",
      loadFailed: "Failed to load config",
      loading: "Loading…",
      roots: "Extra writable roots (one absolute path per line; ~ allowed)",
      presetsTitle: "Common tool caches (one-tap add):",
      placeholder: "~/data\n/tmp/cache",
      rootInvalid: "Line {n} \"{v}\" is not an absolute path; saving will be rejected",
      rootDuplicate: "Line {n} \"{v}\" duplicates an earlier line (deduped by host)",
      rootDanger: "Line {n} \"{v}\" will be rejected: granting it disables the sandbox boundary",
      rootHomeAncestor: "Line {n} \"{v}\" will be rejected: it is a parent of the home directory",
      rootSystem: "Line {n} \"{v}\" will be ignored: system directory"
    };

    function SandboxRootsCard(props: any) {
      // plugins.bundle.config 契约只 dispatch page 视图；防御性处理其余取值，
      // 一句话 summary 不读配置、不发请求。view 判断留在无 hooks 的外层，
      // 内层表单组件的 hooks 顺序不受影响。
      if (props.view !== "page") return props.t("summary");
      return React.createElement(SandboxRootsForm, props);
    }

    function SandboxRootsForm(props: any) {
      const t = props.t;
      const [open, setOpen] = React.useState(false);
      const [cfg, setCfg] = React.useState<any>(null);
      // textarea 的原始字符串在编辑期就是 source of truth:受控组件若在
      // onChange 里 split/filter 再 join,用户刚敲的换行会被立即吞掉——
      // 输入 "/tmp/a" 回车再输 "b" 会静默拼成 "/tmp/a/b" 并授予错误写权限。
      // 换行/空行/行首尾空格只在保存时解析。
      const [draftText, setDraftText] = React.useState<string | null>(null);
      const [saving, setSaving] = React.useState(false);
      const [status, setStatus] = React.useState<any>(null);

      // 最新基准镜像：展开重读时判断“用户是否动过输入”，避免覆盖编辑
      // （与 WorkBuddy 的 statusesRef/openIdsRef 同一写法）。
      const cfgRef = React.useRef<any>(null);
      cfgRef.current = cfg;
      // 展开时静默重读配置：CLI/别处改过后页面不显示陈旧值。用户没动过
      // 输入（与旧基准一致）才跟进新值；动过则保留编辑，dirty 按新基准
      // 重算。首展即首读：挂载不再预拉（面板收着时读了也看不见）。
      React.useEffect(() => {
        if (!open) return;
        let cancelled = false;
        props.getConfig().then((value: any) => {
          if (cancelled) return;
          const freshRoots = ((value && value.extraWritableRoots) || []).join("\n");
          const prevRoots = ((cfgRef.current && cfgRef.current.extraWritableRoots) || []).join("\n");
          setCfg(value);
          setDraftText((current: any) => {
            const text = current === null ? prevRoots : String(current);
            const normalized = text.split("\n").map((s: string) => s.trim()).filter((s: string) => s.length > 0).join("\n");
            return normalized === prevRoots ? freshRoots : current;
          });
        }).catch((error: any) => {
          if (!cancelled) setStatus({ kind: "error", text: `${error?.message || String(error)}`.length > 0 ? `${t("loadFailed")}: ${error?.message || String(error)}` : t("loadFailed") });
        });
        return () => { cancelled = true; };
      }, [open]);
      // 成功提示几秒后自动消失（与 session-archive 的 notice 策略统一）：
      // 错误常驻——需用户处理，编辑/重读时才清除。
      React.useEffect(() => {
        if (status === null || status.kind === "error") return;
        const id = globalThis.setTimeout(() => setStatus(null), 5000);
        return () => clearTimeout(id);
      }, [status]);

      const cfgRoots = cfg === null ? [] : (cfg.extraWritableRoots || []);
      const parsedRoots = draftText === null ? cfgRoots
        : draftText.split("\n").map((s: string) => s.trim()).filter((s: string) => s.length > 0);
      const dirty = cfg !== null && parsedRoots.join("\n") !== cfgRoots.join("\n");
      // 保存前的即时反馈：哪些行会被 host 拒绝/忽略/去重，不再等保存后才发现。
      const rootProblems = draftText === null ? [] : analyzeRootsText(draftText);
      const hasBlocking = hasBlockingProblems(rootProblems);
      const discard = () => {
        setDraftText(cfgRoots.join("\n"));
        setStatus(null);
      };
      const save = () => {
        setSaving(true);
        setStatus(null);
        const next = { ...(cfg ?? {}), extraWritableRoots: parsedRoots };
        props.setConfig(next).then(() => {
          setCfg(next);
          setDraftText(parsedRoots.join("\n"));
          setStatus({ kind: "ok", text: t("saved") });
        }).catch((error: any) => {
          setStatus({ kind: "error", text: `${t("saveFailed")}: ${error?.message || String(error)}` });
        }).finally(() => setSaving(false));
      };

      return React.createElement(
        "div",
        { className: "ser_card", "data-open": open },
        React.createElement(
          "button",
          { className: "ser_header", type: "button", onClick: () => setOpen(!open), "aria-expanded": open, "aria-controls": "ser-roots-body" },
          React.createElement("span", { className: "ser_title" }, t("title")),
          dirty ? React.createElement("span", { className: "ser_badge" }, t("unsaved")) : null,
          React.createElement("span", { "aria-hidden": true }, open ? "▲" : "▼")
        ),
        open ? React.createElement(
          "div",
          { className: "ser_body", id: "ser-roots-body" },
          React.createElement("p", { className: "ser_hint" }, t("hint")),
          React.createElement(
            "div",
            { style: { display: "flex", flexWrap: "wrap", gap: "6px", margin: "2px 0 4px", alignItems: "center" } },
            React.createElement("span", { className: "ser_label" }, t("presetsTitle")),
            // 预设 chips：点选即显式加入（用户对亲手加入的负责），复用保存
            // 按钮同款 ser_action 样式；未加载/保存中禁用，与输入框同口径。
            ...presetsForPlatform(isDarwin, isWindows).map((path) => React.createElement(
              "button",
              {
                key: path,
                className: "ser_action",
                type: "button",
                disabled: saving || cfg === null,
                title: path,
                onClick: () => {
                  setDraftText((current: any) => appendRootLine(current, path));
                  setStatus(null); // 同手输编辑：过期的“已保存”提示失效
                }
              },
              path
            ))
          ),
          React.createElement(
            "label",
            { className: "ser_field" },
            React.createElement("span", { className: "ser_label" }, t("roots")),
            React.createElement("textarea", {
              className: "ser_textarea",
              value: draftText ?? "",
              placeholder: t("placeholder"),
              spellCheck: false,
              disabled: cfg === null,
              onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => {
                setDraftText(e.target.value);
                setStatus(null); // 新的编辑让过期的"已保存"失效
              }
            })
          ),
          rootProblems.length > 0 ? React.createElement(
            "span",
            { className: "ser_hint", role: "note", style: { display: "block", marginTop: "2px" } },
            rootProblems.map((problem, index) => {
              const kind = problem.kind;
              const isDanger = kind === "danger" || kind === "homeAncestor" || kind === "invalid";
              const isWarn = kind === "system";
              const prefix = isDanger ? "⛔ " : isWarn ? "⚠ " : "💡 ";
              const cls = isDanger ? "ser_hint ser_danger" : isWarn ? "ser_hint ser_warn" : "ser_hint ser_info";
              // emoji 前缀仅视觉编码（语义已在文案里），对读屏隐藏。
              return React.createElement("span", { key: index, className: cls, style: { display: "block" } },
                React.createElement("span", { "aria-hidden": true }, prefix),
                t("root" + kind.charAt(0).toUpperCase() + kind.slice(1))
                  .replace("{n}", String(problem.line))
                  .replace("{v}", problem.value)
              );
            })
          ) : null,
          // 错误独立块级展示（role=alert）：此前错误复用 footer 的 ser_status
          // 行（role=status），语义不对且窄行易截断。
          status !== null && status.kind === "error" ? React.createElement(
            "p",
            { className: "ser_error", role: "alert" },
            status.text
          ) : null,
          React.createElement(
            "div",
            { className: "ser_footer" },
            React.createElement(
              "span",
              {
                className: "ser_status",
                role: "status",
                // 初次读取配置期间给出加载提示：此前只显示禁用的空白表单，
                // 无法区分加载中与加载失败。
                style: status === null && cfg === null ? { display: "inline-flex", alignItems: "center", gap: "5px" } : void 0
              },
              status !== null && status.kind !== "error" ? status.text
                : status === null && cfg === null
                  ? [React.createElement("span", { className: "ser_spin", key: "spin", "aria-hidden": true }), t("loading")]
                  : ""
            ),
            React.createElement(
              "button",
              { className: "ser_discard", type: "button", disabled: saving || cfg === null || !dirty, onClick: discard },
              t("discard")
            ),
            React.createElement(
              "button",
              { className: "ser_save", type: "button", disabled: saving || cfg === null || !dirty || hasBlocking, onClick: save },
              saving ? t("saving") : t("save")
            )
          )
        ) : null
      );
    }

    // ── 插件 apply ───────────────────────────────────────────────────────
    // DSH 客户端的 remote.<ns> 服务不会自动生成：必须由客户端代码用
    // ctx.remote.$mount(contribution) 显式挂载（官方 dsh-api-remotes 即如此）。
    // 若只把 remote.sandboxExtraRootsConfig 写进 inject 而不挂载，命名空间
    // 永远不存在，客户端插件会一直 pending，web boot 报 "did not activate"。
    // 因此本插件先挂载自己的命名空间，再注册设置卡片。
    const inject = ["slots", "locale", "remote"];
    const passthroughSchema = { parse: (value: any) => value };
    const REMOTE_CONTRIBUTION: TypertRemoteContribution = {
      package: "@chaoset/sandbox-extra-roots",
      descriptors: [
        {
          id: "@chaoset/sandbox-extra-roots#sandboxExtraRootsConfig/get",
          service: "sandboxExtraRootsConfig",
          namespace: "sandboxExtraRootsConfig",
          method: "get",
          invocation: { kind: "direct" },
          parameters: [],
          result: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/get:result", create: () => passthroughSchema }
        },
        {
          id: "@chaoset/sandbox-extra-roots#sandboxExtraRootsConfig/set",
          service: "sandboxExtraRootsConfig",
          namespace: "sandboxExtraRootsConfig",
          method: "set",
          invocation: { kind: "direct" },
          parameters: [{
            name: "partial",
            wire: "partial",
            source: "json",
            codec: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/set:partial", create: () => passthroughSchema }
          }],
          result: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/set:result", create: () => passthroughSchema }
        }
      ]
    };
    // 与 dsh-any-connect / provider-usage 同一条兜底边界：slot API 破坏时
    // 降级为 console.error（设置页少一张卡片），不得把异常抛给宿主 loader
    // 炸出整页红条——纯 additive 的配置卡没有资格打断宿主。
    async function apply(ctx: any) {
      try {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => {
        try {
          ctx.locale.register(NS, { zh, en });
        } catch (error) {
          // 重复注册(HMR/热切换下宿主已持有同 ns 字典)静默忽略,
          // 其余失败只告警——卡片文案回退到宿主默认,不阻断插件激活。
          const message = String((error as any)?.message ?? error);
          if (!message.includes("already")) console.warn("sandbox-extra-roots: locale dictionary registration failed: " + message);
        }
      }, "sandbox-extra-roots: dictionaries");
      // 先挂载命名空间，再用 ctx.get 取回服务：cordis 的属性访问（ctx.remote.X）
      // 要求 X 出现在 inject 里，而本插件的命名空间由自己挂载，若写进 inject
      // 会和自己等待的服务形成死锁，因此用 ctx.get（对未声明的服务合法）。
      await ctx.remote.$mount(REMOTE_CONTRIBUTION);
      const configService = ctx.get("remote.sandboxExtraRootsConfig");
      if (configService === void 0) throw new Error("sandbox-extra-roots: remote.sandboxExtraRootsConfig did not materialize after mount");
      const getConfig = () => configService.get().then((result: any) => {
        if (!result.ok) throw new Error(`sandboxExtraRootsConfig.get failed: ${result.error.code}: ${result.error.message}`);
        return result.value.config;
      });
      const setConfig = (partial: any) => configService.set(partial).then((result: any) => {
        if (!result.ok) throw new Error(`sandboxExtraRootsConfig.set failed: ${result.error.code}: ${result.error.message}`);
        return result.value;
      });
      ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config",
        // keyed slot：key 为 bundle 的 npm 包名（plugins.bundle.config 契约，
        // 与 package.json "name" / cordis.patch.yml 的 name 一致），配置表单
        // 显示在本插件 Plugins 页（描述与 rows 之间）。
        key: "@chaoset/sandbox-extra-roots",
        locale: NS,
        inject: () => ({ getConfig, setConfig })
      }, SandboxRootsCard));
      } catch (error: any) {
        console.error("[sandbox-extra-roots] client card failed to load (settings card missing):", error);
      }
    }

    export { apply, inject, analyzeRootsText, hasBlockingProblems, appendRootLine, presetsForPlatform };