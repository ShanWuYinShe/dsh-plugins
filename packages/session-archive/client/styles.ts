/**
 * styles.ts — 面板样式表与 style 标签注入。
 *
 * 2026-10-08 从 1194 行的 client/index.tsx 拆出：样式、文案、纯逻辑与面板组件
 * 各自成模块，入口只保留注册与 re-export。
 *
 * @module @chaoset/session-archive/client/styles
 */



export var css = [
  // sa_root 是 footerActions（display:flex）的直接 flex 项（slot 出口为
  // display:contents 不参与布局）：不设宽度的话 flex 项收缩到内容宽，
  // 徽标的 width:calc(100% + 4px) 只等于内容宽，hover 高亮比「设置」
  // 入口窄一圈。显式撑满 + min-width:0，与 settingsArea 块级容器里的
  // 设置按钮获得同样的整行命中面积。
  ".sa_root{display:flex;min-width:0;width:100%}",
  // 徽标几何与官方侧边栏「设置」触发按钮（dsh-client-ui-settings-general
  // 的 .trigger / .rail）逐字对齐：同样的 calc(+4px) 宽度、42px 高、负外边距、
  // 非对称内边距、12px 圆角与同一 hover 变量——保证归档入口的 hover 命中
  // 面积与视觉节奏和设置入口完全一致（收起态同为 36×36 圆形）。
  ".sa_badge{box-sizing:border-box;cursor:pointer;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);background:0 0;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;transition:background-color .15s ease}",
  ".sa_badge:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".sa_badgeIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-primary)}",
  ".sa_badgeIcon svg{width:16px;height:16px;display:block}",
  ".sa_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
  ".sa_badgeCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}",
  ".sa_badge--collapsed{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:8px 0 10px;padding:0}",
  ".sa_badge--collapsed .sa_badgeLabel,.sa_badge--collapsed .sa_badgeCount{display:none}",
  ".sa_badge--collapsed .sa_badgeIcon,.sa_badge--collapsed .sa_badgeIcon svg{width:18px;height:18px}",
  // 页面居中模态：z-index 30 高于侧边栏、低于宿主全局遮罩。
  ".sa_panel{z-index:30;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));width:780px;max-width:calc(100vw - 32px);max-height:min(84vh,calc(100vh - 64px));min-height:min(420px,calc(100vh - 64px));box-shadow:0 32px 80px rgba(0, 0, 0, 0.45), 0 12px 28px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(127, 127, 127, 0.12);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:16px;flex-direction:column;display:flex;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);overflow:hidden}",
  // 遮罩层：居中模态弹窗的视口级半透明底层，点击关闭面板。
  ".sa_overlay{position:fixed;inset:0;z-index:29;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}",
  // 入场动画：面板 150ms 淡入 + 轻微放大，遮罩 150ms 淡入。
  // 系统开启「减少动态效果」时完全禁用。
  "@media (prefers-reduced-motion:no-preference){.sa_panel{animation:sa-panel-in .15s ease-out}}",
  "@keyframes sa-panel-in{from{opacity:0;transform:translate(-50%,-50%) scale(.97)}}",
  "@media (prefers-reduced-motion:no-preference){.sa_overlay{animation:sa-overlay-in .15s ease-out}}",
  "@keyframes sa-overlay-in{from{opacity:0}}",
  ".sa_panel:focus{outline:none}",
  ".sa_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;flex:none;justify-content:space-between;align-items:center;gap:12px;min-height:60px;padding:14px 20px;display:flex}",
  ".sa_title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:700;line-height:24px;white-space:nowrap}.sa_titleWrap{display:flex;align-items:center;gap:10px;min-width:0}.sa_countPill{flex:none;font-size:12px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary,#1677ff);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#1677ff) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#1677ff) 30%,transparent);border-radius:999px;padding:1px 9px}.sa_headerActions{display:inline-flex;gap:8px;align-items:center;flex:none}",
  ".sa_iconBtn{font:inherit;cursor:pointer;border:0;border-radius:8px;width:36px;height:36px;color:var(--dsw-alias-label-secondary,#666);background:0 0;display:inline-flex;align-items:center;justify-content:center;font-size:18px}",
  ".sa_refresh{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-height:36px;padding:5px 14px;font-size:13px;line-height:20px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:5px}",
  ".sa_refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
  ".sa_refresh:disabled{opacity:.4;cursor:default}",
  ".sa_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
  ".sa_iconBtn:disabled{opacity:.4;cursor:default}",
  ".sa_toolbar{flex:none;border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:10px;padding:10px 20px;display:flex;flex-wrap:wrap}",
  ".sa_filterInput{flex:1 1 100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}",
  ".sa_filterInput::placeholder{color:var(--dsw-alias-label-tertiary)}",
  ".sa_filterInput:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
  ".sa_check{accent-color:var(--dsw-alias-label-primary);width:14px;height:14px;flex:none;cursor:pointer}",
  ".sa_check:disabled{cursor:default;opacity:.45}",
  ".sa_toolLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;user-select:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px}",
  ".sa_count{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;flex:1}",
  ".sa_action{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 10px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);transition:all .15s ease}",
  ".sa_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}",
  ".sa_action:disabled{opacity:.4;cursor:default}",
  ".sa_actionDanger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}",
  ".sa_actionDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary)}",
  ".sa_actionDanger:disabled{opacity:.4}",
  ".sa_confirm{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}",
  ".sa_confirm:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:#fff}",
  ".sa_body{flex:1;min-height:0;padding:12px 20px 20px;overflow-y:auto}",
  ".sa_empty{color:var(--dsw-alias-label-tertiary);margin:24px 0;text-align:center;font-size:12px;line-height:18px}",
  ".sa_error{color:var(--dsw-alias-state-error-primary);margin:8px 0;font-size:12px;line-height:18px}",
  ".sa_ok{color:var(--dsw-alias-state-success-primary);margin:8px 0;font-size:12px;line-height:18px}",
  // 提示级通知（如「请先勾选会话」）不该与错误同色：用 warn 色区分严重度。
  ".sa_warn{color:var(--dsw-alias-state-warn-primary);margin:8px 0;font-size:12px;line-height:18px}",
  // 大批量删除确认条：错误色边框 + 浅红底（12% mix，与宿主 Tag danger 同口径）。
  ".sa_ack{border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-radius:12px;padding:10px 12px;margin:0 0 8px;flex-direction:column;gap:8px;display:flex}",
  ".sa_ackText{color:var(--dsw-alias-label-primary);margin:0;font-size:12px;line-height:18px}",
  ".sa_ackLabel{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;user-select:none;cursor:pointer;display:inline-flex;align-items:center;gap:6px}",
  ".sa_ackActions{justify-content:flex-end;display:flex}",
  ".sa_rows{flex-direction:column;gap:10px;margin:0;padding:2px 2px 4px;list-style:none;display:flex}",
  ".sa_row{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:14px;flex-direction:column;gap:6px;padding:12px 14px;display:flex;transition:border-color .15s ease,box-shadow .15s ease,transform .15s ease}",
  ".sa_row:hover{border-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv1),0 4px 16px rgba(0,0,0,.12);transform:translateY(-1px)}.sa_row--selected{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#1677ff) 55%,transparent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary,#1677ff) 45%,transparent)}",
  ".sa_row .sa_check{opacity:.55;transition:opacity .15s ease}",
  ".sa_row:hover .sa_check{opacity:1}",
  ".sa_rowHead{align-items:center;gap:8px;display:flex}",
  ".sa_rowTitle{background:none;border:none;padding:0;text-align:left;font:inherit;min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px;font-weight:500;line-height:20px;overflow:hidden;cursor:pointer}",
  ".sa_rowTitle:hover{text-decoration:underline}",
  ".sa_live{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);height:18px;border-radius:9px;flex:none;align-items:center;padding:0 6px;font-size:11px;line-height:18px;display:inline-flex}",
  ".sa_rowMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}",
  ".sa_rowMeta code{font-family:var(--ds-font-family-code,monospace)}",
  ".sa_rowFoot{justify-content:space-between;align-items:center;gap:8px;display:flex}",
  ".sa_rowActions{flex:none;align-items:center;gap:8px;display:flex}",
  ".sa_detail{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:10px;margin-top:2px;flex-direction:column;gap:10px;display:flex;max-height:360px;overflow-y:auto}",
  ".sa_msg{flex-direction:column;gap:2px;display:flex}",
  ".sa_msgRole{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;text-transform:uppercase;letter-spacing:.04em}",
  ".sa_msgText{color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:18px}",
  ".sa_msgTextUser{color:var(--dsw-alias-label-secondary)}",
  ".sa_msgBubble{max-width:85%;padding:8px 12px;border-radius:12px;font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}",
  // 用户气泡是「品牌色填充面」：文字必须配 label-primary-foreground，
  // 不能写死 #fff——浅色主题下 brand-primary 解析为 near-black（配白字尚可），
  // 深色主题下解析为 near-white，白字压白底对比度仅 1.05:1，整条消息看不见。
  // 该配对是宿主 Button.module.css 的 .primary 同款写法，两种主题都约 18.9:1。
  ".sa_msgUser{align-self:flex-end;background:var(--dsw-alias-brand-primary,#1677ff);color:var(--dsw-alias-label-primary-foreground,#fff);border-bottom-right-radius:4px}",
  ".sa_msgAssistant{align-self:flex-start;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,0.04));color:var(--dsw-alias-label-primary);border-bottom-left-radius:4px}",
  ".sa_msgRoleChip{display:inline-block;font-size:10px;line-height:14px;padding:1px 6px;border-radius:4px;margin-bottom:2px}",
  // 角色标签是气泡上方的兄弟节点，落在行背景（.sa_row = bg-base）上而非
  // 品牌色气泡内，所以不能用白色：浅色主题下白字压白底同样看不见。
  // 与助手标签同用主题弱化标签色，仅靠对齐方向区分。
  ".sa_msgRoleUser{color:var(--dsw-alias-label-secondary);align-self:flex-end}",
  ".sa_msgRoleAssistant{color:var(--dsw-alias-label-tertiary);align-self:flex-start}",
  ".sa_overlay--closing{opacity:0;transition:opacity .15s ease-out}",
  ".sa_panel--closing{opacity:0;transform:translate(-50%,-50%) scale(.97);transition:opacity .15s ease-out,transform .15s ease-out}",
  ".sa_busy{opacity:.55;pointer-events:none}",
  // 加载中：spinner + 文案（列表与详情共用）。系统开启「减少动态效果」时
  // spinner 停止旋转（保持静态圆环，提示语义仍在）。
  ".sa_loading{color:var(--dsw-alias-label-tertiary);margin:8px 0;font-size:12px;line-height:18px;display:flex;align-items:center;gap:6px}",
  ".sa_spin{flex:none;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:sa-spin .8s linear infinite}",
  "@keyframes sa-spin{to{transform:rotate(360deg)}}",
  "@media (prefers-reduced-motion:reduce){.sa_spin{animation:none}}",
  ".sa_badge:focus-visible,.sa_action:focus-visible,.sa_refresh:focus-visible,.sa_iconBtn:focus-visible,.sa_rowTitle:focus-visible,.sa_filterInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1677ff);outline-offset:2px}",
  ".sa_refresh{min-height:32px;padding:4px 12px;border-radius:8px;font-weight:500}",
  ".sa_iconBtn{width:32px;height:32px;border-radius:8px}",
  ".sa_action{padding:5px 12px;border-radius:8px;font-weight:500}",
  "@media (max-width:560px){.sa_panel{border-radius:12px}.sa_header,.sa_toolbar{padding-left:14px;padding-right:14px}.sa_body{padding:10px 14px 16px}}"
].join("");

var tagId = "@chaoset/session-archive/client.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
  var tag = document.createElement("style");
  tag.dataset.plugin = "@chaoset/session-archive";
  tag.dataset.pluginCss = tagId;
  tag.textContent = css;
  document.head.appendChild(tag);
}

// ── 字典 ─────────────────────────────────────────────────────────────
