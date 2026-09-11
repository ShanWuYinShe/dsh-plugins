import * as React from "react";
import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

var css = ".ser_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;min-width:0;overflow:hidden}.ser_card[data-open=true]{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1)}.ser_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:10px;align-items:center;gap:12px;padding:12px 14px;display:flex}.ser_header:hover,.ser_card[data-open=true]>.ser_header{background:var(--dsw-alias-interactive-bg-hover)}.ser_title{flex:1;min-width:0;font-size:14px;font-weight:600;line-height:20px}.ser_badge{white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:16px}.ser_body{border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);padding:10px 14px 12px}.ser_field{flex-direction:column;gap:4px;padding:8px 0;display:flex}.ser_label{font-size:12px;font-weight:500;line-height:18px}.ser_textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:6px;padding:6px 10px;font-size:12px;line-height:18px;resize:vertical;min-height:120px;font-family:var(--ds-font-family-code,monospace)}.ser_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:16px}.ser_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:8px 0 2px;display:flex}.ser_save{font:inherit;cursor:pointer;border:1px solid transparent;border-radius:6px;padding:4px 14px;font-size:12px;line-height:18px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.ser_save:disabled{opacity:.4;cursor:default}.ser_discard{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:0 0;color:var(--dsw-alias-label-secondary,#666);border-radius:6px;padding:4px 14px;font-size:12px;line-height:18px}.ser_discard:disabled{opacity:.4;cursor:default}.ser_status{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.ser_warn{color:var(--dsw-alias-state-warn-primary)}.ser_error{color:var(--dsw-alias-state-error-primary)}.ser_spin{flex:none;width:10px;height:10px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:ser-spin .8s linear infinite}@keyframes ser-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.ser_spin{animation:none}}";

    var tagId = "@chaoset/sandbox-extra-roots/client.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "@chaoset/sandbox-extra-roots";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const NS = "settings.plugins.sandboxExtraRoots";
    // 与 host classifyRoot 的过滤口径保持一致的客户端预览（词法级）：
    // 让"会被静默丢弃的行"在保存前就可见，而不是保存后只看到"已保存"。
    const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin"];
    function analyzeRootsText(text: string) {
      const problems: Array<{ line: number; kind: string; value: string }> = [];
      const seen = new Set<string>();
      text.split("\n").forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (line.length === 0) return;
        // ~ / ~/x：host 保存时展开为用户主目录，客户端无法解析 home，视为合法。
        if (line === "~" || line.startsWith("~/") || line.startsWith("~\\")) return;
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
        if (normalized === "/" || /^[a-zA-Z]:[\\/]?$/.test(normalized)) {
          problems.push({ line: index + 1, kind: "danger", value: line });
        } else if (SYSTEM_DIRS.includes(normalized.replace(/\\/g, "/").toLowerCase())) {
          problems.push({ line: index + 1, kind: "system", value: line });
        }
      });
      return problems;
    }
    const zh = {
      title: "沙盒额外允许目录（sandbox-extra-roots）",
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
      placeholder: "~/data\n/tmp/cache",
      rootInvalid: "第 {n} 行「{v}」不是绝对路径，保存将被拒绝",
      rootDuplicate: "第 {n} 行「{v}」与前面的行重复（host 会去重）",
      rootDanger: "第 {n} 行「{v}」会被拒绝：授予它等于解除沙盒边界",
      rootSystem: "第 {n} 行「{v}」会被忽略：系统目录"
    };
    const en = {
      title: "Extra sandbox roots (sandbox-extra-roots)",
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
      placeholder: "~/data\n/tmp/cache",
      rootInvalid: "Line {n} \"{v}\" is not an absolute path; saving will be rejected",
      rootDuplicate: "Line {n} \"{v}\" duplicates an earlier line (deduped by host)",
      rootDanger: "Line {n} \"{v}\" will be rejected: granting it disables the sandbox boundary",
      rootSystem: "Line {n} \"{v}\" will be ignored: system directory"
    };

    function SandboxRootsCard(props: any) {
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

      React.useEffect(() => {
        let cancelled = false;
        props.getConfig().then((value: any) => {
          if (cancelled) return;
          setCfg(value);
          setDraftText(((value && value.extraWritableRoots) || []).join("\n"));
        }).catch((error: any) => {
          if (!cancelled) setStatus({ kind: "error", text: `${error?.message || String(error)}`.length > 0 ? `${t("loadFailed")}: ${error?.message || String(error)}` : t("loadFailed") });
        });
        return () => { cancelled = true; };
      }, []);

      const cfgRoots = cfg === null ? [] : (cfg.extraWritableRoots || []);
      const parsedRoots = draftText === null ? cfgRoots
        : draftText.split("\n").map((s: string) => s.trim()).filter((s: string) => s.length > 0);
      const dirty = cfg !== null && parsedRoots.join("\n") !== cfgRoots.join("\n");
      // 保存前的即时反馈：哪些行会被 host 拒绝/忽略/去重，不再等保存后才发现。
      const rootProblems = draftText === null ? [] : analyzeRootsText(draftText);
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
        "li",
        { className: "ser_card", "data-open": open },
        React.createElement(
          "button",
          { className: "ser_header", type: "button", onClick: () => setOpen(!open), "aria-expanded": open },
          React.createElement("span", { className: "ser_title" }, t("title")),
          dirty ? React.createElement("span", { className: "ser_badge" }, t("unsaved")) : null,
          React.createElement("span", { "aria-hidden": true }, open ? "▲" : "▼")
        ),
        open ? React.createElement(
          "div",
          { className: "ser_body" },
          React.createElement("p", { className: "ser_hint" }, t("hint")),
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
            { className: "ser_hint ser_warn", role: "note", style: { display: "block", marginTop: "2px" } },
            rootProblems.map((problem, index) =>
              React.createElement("span", { key: index, style: { display: "block" } },
                t("root" + problem.kind.charAt(0).toUpperCase() + problem.kind.slice(1))
                  .replace("{n}", String(problem.line))
                  .replace("{v}", problem.value)))
          ) : null,
          React.createElement(
            "div",
            { className: "ser_footer" },
            React.createElement(
              "span",
              {
                className: "ser_status" + (status !== null && status.kind === "error" ? " ser_error" : ""),
                role: "status",
                // 初次读取配置期间给出加载提示：此前只显示禁用的空白表单，
                // 无法区分加载中与加载失败。
                style: status === null && cfg === null ? { display: "inline-flex", alignItems: "center", gap: "5px" } : void 0
              },
              status !== null ? status.text
                : cfg === null
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
              { className: "ser_save", type: "button", disabled: saving || cfg === null || !dirty, onClick: save },
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
          result: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/get:result", schema: passthroughSchema }
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
            codec: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/set:partial", schema: passthroughSchema }
          }],
          result: { mode: "strict", typeSymbol: "sandboxExtraRootsConfig/set:result", schema: passthroughSchema }
        }
      ]
    };
    async function apply(ctx: any) {
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
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        // keyed slot：key 为卡片编辑的设置 namespace（与 host 侧
        // registerSettingsNamespace 的 ns 一致，须匹配宿主 ^[a-z][a-z0-9-]*$），
        // 设置页按 key 与宿主 describe 的 namespace 配对渲染。
        key: "sandbox-extra-roots-config",
        id: "sandbox-extra-roots",
        order: 40,
        locale: NS,
        inject: () => ({ getConfig, setConfig })
      }, SandboxRootsCard));
    }

    export { apply, inject };