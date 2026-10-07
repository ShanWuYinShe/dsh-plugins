/**
 * SandboxRootsCard.tsx — 设置页的授权根卡片（表单 + 预览 + 保存）。
 *
 * 2026-10-08 从 425 行的单体 client/index.tsx 拆出。
 *
 * @module sandbox-extra-roots/SandboxRootsCard
 */

import * as React from 'react'
import { isDarwin, isWindows, analyzeRootsText, hasBlockingProblems, presetsForPlatform, appendRootLine } from './roots-preview.js'

export function SandboxRootsCard(props: any) {
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
      React.createElement("span", { className: "ser_titleIcon", "aria-hidden": true },
        React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
          React.createElement("path", { d: "M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" }),
          React.createElement("path", { d: "M9 12l2 2 4-4" }))),
      React.createElement("span", { className: "ser_title" }, t("title")),
      dirty ? React.createElement("span", { className: "ser_badge" }, t("unsaved")) : null,
      React.createElement("span", { className: "ser_chev", "aria-hidden": true },
        React.createElement("svg", { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
          React.createElement("path", { d: "M4 6l4 4 4-4" })))
    ),
    open ? React.createElement(
      "div",
      { className: "ser_body", id: "ser-roots-body" },
      React.createElement("p", { className: "ser_hint" }, t("hint")),
      React.createElement(
        "div",
        { className: "ser_presets" },
        React.createElement("span", { className: "ser_label" }, t("presetsTitle")),
        React.createElement("div", { className: "ser_presetsRow" },
        // 预设 chips：点选即显式加入（用户对亲手加入的负责），未加载/保存中
        // 禁用，与输入框同口径。
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
        )))
      ),
      React.createElement(
        "label",
        { className: "ser_field" },
        React.createElement("div", { className: "ser_labelRow" },
          React.createElement("span", { className: "ser_label" }, t("roots")),
          React.createElement("span", { className: "ser_count" }, t("rootsCount").replace("{n}", String(parsedRoots.length)))),
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
        "div",
        { className: "ser_problems", role: "note" },
        rootProblems.map((problem, index) => {
          const kind = problem.kind;
          const isDanger = kind === "danger" || kind === "homeAncestor" || kind === "invalid";
          const isWarn = kind === "system";
          const cls = isDanger ? "ser_problem ser_problem--danger" : isWarn ? "ser_problem ser_problem--warn" : "ser_problem ser_problem--info";
          return React.createElement("div", { key: index, className: cls },
            t("root" + kind.charAt(0).toUpperCase() + kind.slice(1))
              // 函数替换:{v} 是用户输入的原始行,字符串替换串里的 $&/$`/$'
              // 等特殊序列会把模板前后文拼进预览,显示的路径与实际输入不符。
              .replace("{n}", () => String(problem.line))
              .replace("{v}", () => problem.value)
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
            className: "ser_status" + (status !== null && status.kind === "ok" ? " ser_status--ok" : ""),
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
