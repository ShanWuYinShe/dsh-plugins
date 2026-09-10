# Changelog

## 0.10.7 (2026-09-10)

### Changes

* 跟进 DSH 稳定版 0.1.5-rc.1（合并 alpha 线 0.10.7-alpha.0 ~ alpha.1 的适配
  内容）：全部 `@deepseek-ai/dsh-*` optionalDependencies 由 `^0.1.2-rc.1`
  升至 `^0.1.5-rc.1`，`dsh.host` 更新为 `0.1.5-rc.1`
* 对照 0.1.5-rc.1 复核契约：systemPrompt / tools / agentPresets 契约无变化，
  build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.10.6 (2026-09-05)

### Refactoring

* 可维护性清理，无功能变更：删除确认死代码（adaptive-perf 的
  `filterBootstrapTools` 与 dev_tool_search 的不可达默认文案）、提取
  `quietDispose` / `disposeAll` 释放助手替换 14 处重复的静默 try/catch、
  魔法数字提为命名常量、修正两处过时注释（测试路径引用、重复标题）。
  另有 scripts 共享工具提取（dsh-baseline / dsh-follow-status 共用
  `scripts/lib/dsh-deps.mjs`，发布产物不含 scripts）。

## 0.10.5 (2026-09-05)

### Fixes

* 0.10.4 的 `dsh.host` 字段因改动散落两个工作树未随 0.10.4 的提交进入发布产物——本版本重新包含该字段。此外无任何变更。

## 0.10.4 (2026-09-05)

### Metadata

* package.json 新增 `dsh.host` 字段：声明本包适配的 DSH 版本，随每次
  宿主适配由 `adapt-dsh.mjs` 自动维护；`npm view <包名> dsh.host` 可查，
  README 安装节与仓库 `dsh-v*` 归档 tag 同步标注。无功能变更。

## 0.10.3 (2026-09-05)

### Fixes

* 全新安装缺 `ptc` preset：`cordis.patch.yml` 的 `presets` 与
  `DEFAULT_CONFIG` 对齐（补 `ptc`）——此前全新安装的 PTC 会话完全不被
  接管（存量用户不受影响，patch 已落盘）
* `escalateOnUnknownTool` 在首轮锚定（bootstrap）阶段失效：失败信号的
  隐藏集现在计入 bootstrap deny（默认配置下这是工具隐藏的唯一来源）。
  命中的隐藏工具属于某工具族时放行整族；不属于任何族（如 `read`/
  `write` 等核心编码工具）时按名解锁该工具（与晋升后 dev_tool_search
  的解锁同一通道，下一请求生效），PTC 程序不再对这些工具永远 UNKNOWN_TOOL

### Docs

* README 同步失败信号对 bootstrap 阶段的行为说明

## 0.10.2 (2026-09-03)

### Changes

* alpha 线合并 + 稳定线跟进 DSH 0.1.2-rc.1：6 个 `@deepseek-ai/dsh-*`
  optionalDependencies 由 `^0.1.1-rc.2` 升到 `^0.1.2-rc.1`（合入 alpha 线
  0.10.2-alpha.0 / 0.10.2-alpha.1 的适配内容，功能与 0.10.1 一致）
* 已对照 0.1.2-rc.1 全量 diff 官方包（36 个：逐包与 0.1.2-alpha.5 字节对比，
  除版本号外零差异——rc.1 是纯转正 bump）：依赖的 dsh-terminal /
  dsh-terminal-bash / dsh-tool-bash-persistent / dsh-fs-local /
  dsh-tool-str-replace-editor 与契约相关的 dsh-agent / dsh-tools 均与
  alpha.5 适配时一致，systemPrompt / tools / agentPresets 契约与 minimal
  preset 工具对挂载形状无变化；全仓 build + typecheck + 162 项测试在 rc.1
  依赖闭包上通过

## 0.10.1 (2026-08-29)

### Features

* 设置卡片初次读取配置时在状态栏显示 spinner +「加载中…」（respect
  `prefers-reduced-motion`）：此前只显示禁用态的默认值表单，无法区分加载中与
  加载失败

## 0.10.0 (2026-08-28)

### Features

* 适配 DSH 0.1.2 的 PTC preset 更名：0.1.2 把 PTC 模式的 preset id 由 `code`
  改为 `ptc`，默认 presets 改为 `['standard', 'code', 'ptc', 'cordis']`——新旧
  宿主都覆盖，不存在的 id 无副作用；设置页默认值/提示文本同步

### Bug Fixes

* 支持从源码运行的 DSH：真实 Minimal 工具对的官方包导入链首插安装闭包共享
  fallback `$DSH_HOME/profiles/node_modules/<pkg>`，以 realpath 导入保证与
  harness 同一模块实例；修复本地路径安装时裸 import 解析不到官方包、realPair
  静默降级的问题。已对照 dsh 源码 0.1.2-alpha.1 复核 systemPrompt / tools /
  skills / agentPresets 契约无变化

## 0.9.1 (2026-08-28)

### Bug Fixes

* 适配 DSH 0.1.1-rc.2：6 个 `@deepseek-ai/*` optionalDependencies 的 range 从
  `^0.1.0-rc.8` 升到 `^0.1.1-rc.2`（npm semver 的 prerelease 规则下旧 range
  无法匹配 `0.1.1-rc.2`，新版宿主下官方模块会解析到旧版本或缺失）
* 已对照 0.1.1-rc.2 全量 diff 官方包：各契约无变化，运行时逻辑无需调整

## 0.9.0 (2026-08-25)

### Features

* 设置卡片按语义分组折叠（首轮锚定 / 极简提示词层 / 高级 JSON 默认收起）：
  20+ 字段不再一屏平铺，渐进披露；分组头带 `aria-expanded`
* `bootstrap.maxTokens` 数字输入改草稿态：编辑期保留原始输入（清空/删改中间态
  不立即跳回 0），失焦才归一化显示

### Bug Fixes

* `session/event` 处理器对 `agents.get(session.id)` 的隐含契约
  （`agent.id === session.id`）加防御性兜底（按 `agent.session.id` 匹配）：
  未来二者分离时晋升信号不再静默丢配导致 bootstrap restrict 不释放

## 0.8.0 (2026-08-22)

### Features

* 新增 `keywordMatchMode` 配置（`smart` 默认 / `substring` / `word`）：含 CJK
  的触发词保持子串匹配（CJK 无词边界，`\b` 永远匹配不到纯 CJK 关键词），纯
  ASCII 词按词边界匹配（`(?<![a-z0-9_])kw(?![a-z0-9_])`，比 `\b` 更可预测）。
  "the goal is to refactor" 或 "goalish" 不再因子串 "goal" 误触发 goal 族放行；
  `substring` 恢复此前的行为；`remote.set` 校验并归一化（非法回退默认）
* 所有字符串列表字段（`presets`、`bootstrap.tools`、工具族 tools/keywords 等）
  允许显式空数组：此前清空列表保存会被静默还原为默认值，无法表达「不应用任何
  preset」

### Bug Fixes

* pre-step 注入剥离要求 bootstrap 开启：`bootstrap.enabled=false` 时此前仍会
  剥离注入而没有发现工具补偿，造成不可恢复的上下文丢失
* 热更新 `bootstrap.promoteOn` 对已跟踪会话生效：阶段缓存失效并从持久事件流
  重建（持久晋升信号在重建中保留）
* 降低每条消息开销：composed preset 每个 agent 解析一次而非每条消息；抑制
  source 集合按内容缓存；preset 查找失败告警限 20 次
* 设置卡片：`promoteOn` 改下拉、`maxTokens` 改数字输入（非法输入不可保存）；
  错误提示在折叠态也经头部徽标可见；dirty 判定改为逐字段比较（不再依赖键序
  敏感的 JSON.stringify）；错误色修正为真实存在的 `state-error-primary` token
  （此前引用不存在的 token，错误永远不显示红色）
* 删除与 `stripSuppressedMessages` 完全重复的 `filterBootstrapMessages`；修复
  dev_tool_search 描述截断的运算符优先级 bug

## 0.7.3 (2026-08-22)

### Bug Fixes

* **dev_tool_search 使用 restrict 后的目录（P0）**：被 restrict 隐藏的工具不可
  发现也不可解锁；改为搜索 agent 建立时捕获的 restrict 前快照
* **escalate() 未重算 bootstrap deny 集（P0）**：放行信号后该族工具仍被第二层
  restrict 挡住；escalate 现在同步重算 keep-set，下一次请求生效
* 真实 Minimal 工具对经 state key 幂等重挂：无关热更新不再销毁/重建持久 PTY
  bash（cwd/env/后台任务保留）
* 首轮 maxTokens 封顶改为 listener 内分支（0→N 热更新生效；N→0 剥离字段而非
  注入 0）；晋升时剥离本次会话注入的任何封顶（含热更新前的过期值）
* 设置页定义的自定义工具族不再被 normalizeConfig 静默丢弃
* 测试 mock 对齐宿主行为（schema 反映生效 restrict 层），两个 P0 各补回归测试

## 0.7.2 (2026-08-22)

### Dependencies

* 对齐 dsh 0.1.0-rc.8 依赖集

## 0.7.0 (2026-08-18)

### Features

* **首轮锚定 + 晋升后 resident 目录（anchored-standard 语义）**：只有请求 #1
  按极简条件组装（真实 Minimal 工具对 + 极简 persona + 屏蔽全局引导段 + 剥离
  `skill-catalog`/`agent-instructions` 注入 + 抑制运行时快照）；首个持久晋升
  信号后进入 resident 阶段——工具对与发现工具常驻，完整目录经 `dev_tool_search`
  按需解锁，常规注入恢复可见。只提高性能不减少功能：晋升时一次性倒出完整目录
  会把轨迹拉回 standard-like（参考实现的晋升后回退问题），故完整目录按需取用
* **晋升持久化**：阶段不再因 `compaction/end` 重置；晋升按会话记忆化，resume /
  reload 与压缩后的轮次保持 resident 目录
* **工具目录默认零裁剪**：`leanByDefault` 默认 `false`，编排类工具族（子代理/
  工作流/ralph/goal）不再隐藏除非显式开启；`suppressInjectedContext` 默认
  `true`（晋升后恢复注入会把轨迹拉回 standard-like，"Let me…" 叙述回归），
  设为 `false` 恢复晋升后注入
* **创造模式（cordis）纳入目标 preset**：`presets` 默认
  `["standard", "code", "cordis"]`，创造模式获得同样的首轮极简锚定

### Breaking

* 移除 `skillDiscovery` / `instructionHint` / `bootstrap.compactionTools`；
  恢复 `bootstrap.discoveryTools`（默认 `dev_tool_search` / `skill_search` /
  `skill_load`）作为晋升后常驻发现集。resident 语义下按需发现由常驻
  `dev_tool_search` 承担，指令提示与压缩回退集不再需要；已保存的旧配置自动
  忽略被移除字段

## 0.6.0 (2026-08-17)

### Breaking

* **功能优先——所有优化改为 opt-in**：此前默认值破坏 standard/PTC 功能（工具族
  从目录移除、注入剥离、引导段屏蔽、首轮只留两个工具）。这些机制的收益来自
  移除上下文/工具，没有无损形式，故 `leanByDefault`、`suppressRuntimeContext`、
  `suppressInjectedContext`、`minimalPrompt.enabled`、`bootstrap.enabled` 全部
  默认 `false`：全新安装零干预无副作用，官方 preset 保持完整功能；按需在设置
  页开启，补偿路径（关键词/失败信号放行、发现工具、指令提示）随之激活

## 0.5.3 (2026-08-17)

### Bug Fixes

* 注册设置命名空间时把实时配置快照作为 `base` 传入：无默认值的 schema 曾使
  `settings.describe()` 返回 `value: undefined`，设置页 wire 校验失败、整个
  设置 UI 挂掉；传入 `base` 后返回值始终是完整配置对象

## 0.5.2 (2026-08-17)

### Bug Fixes

* 把配置命名空间注册进宿主 settings 服务（`ctx.settings.register`），设置页
  「插件配置」tab 才会列出卡片（tab 按 `settings.describe()` 分发，未注册的
  命名空间不渲染）。注册只管可见性，卡片读写仍走插件自己的配置网关（config.json
  权威、热更新保留）；settings 服务缺失时 fail-safe，重复注册（HMR）静默忽略

## 0.5.1 (2026-08-17)

### Bug Fixes

* 设置卡片注册补 `key`（settings 命名空间，与 host 侧 service key 一致）：宿主
  `dsh-client-ui-slots` 0.1.0-rc.7 声明为 keyed slot，缺 `key` 会让整个 client
  bundle 激活失败（"Failed to load plugins: keyed slot requires options.key"）

## 0.5.0 (2026-08-16)

### Features

* **首轮真实 Minimal 工具对（`bootstrap.realPair`）**：此前 bootstrap 只是收窄
  standard/PTC 目录，请求 #1 仍是 standard 系 schema（且 standard 不挂
  `str_replace_editor`）。现把官方 minimal preset 同款插件（持久 PTY bash
  `@deepseek-ai/dsh-tool-bash-persistent` + `str_replace_editor`）挂进每个目标
  agent 的会话作用域，按名阴影继承的 sandboxed bash（scoped 注册豁免
  restrict），同时把 `tool:bash` 引导段阴影为空。官方包为
  optionalDependencies，解析不到（或 Windows 无 PTY 后端）时降级为仅收窄目录
  并告警
* **常驻注入剥离（`suppressInjectedContext`，默认开启）**：技能目录提醒与
  AGENTS.md 摘要此前只在请求 #1 剥离、晋升后恢复；实测晋升后它们仍扰动轨迹
  且每请求多耗数千 token。开启后整个会话持续剥离，由常驻 `skill_search` /
  `skill_load` 与一次性 `instruction-hint` 替代；用户主动的技能手势
  （`skill-invocation`）永不过滤
* **常驻发现集纳入 `skill_search` / `skill_load`**：`bootstrap.discoveryTools`
  默认 `[dev_tool_search, skill_search, skill_load]`

## 0.4.0 (2026-08-16)

### Features

* **极简提示词层（minimalPrompt，语域锚定）**：完整的锚定条件是极简的完整
  system prompt——只收窄工具目录不够，全局引导段与标准 persona 会让思维链保持
  standard-like 的 "Let me…" 叙述。本层把三个全局引导段阴影为空（等同极简
  `complete` persona 的效果；plan-mode 与 PTC SDK 段不受影响），并把
  `deployment:persona` 按名替换为与极简模式逐字相同的文本；对已恢复/已晋升的
  旧会话同样生效（bootstrap 阶段不触碰它们）。全部开关可配置、热生效

## 0.3.2 (2026-08-16)

### Bug Fixes

* bootstrap 工具收窄改用 `tools.restrict` 而非过滤 `assembly.tools`：PTC/code
  模式组装目录只含 run_code，过滤收窄总是触发 fail-safe、首轮仍见完整 SDK
  （实测模型看到 15 个工具）。`tools.restrict` 同时驱动 API 目录与 PTC SDK
  参考段（与工具族精简同一机制），bootstrap 改为临时 deny 除 run_code 与
  Minimal 对之外的全部工具，首个持久晋升信号解除

## 0.3.1 (2026-08-16)

### Bug Fixes

* `engines.node` 提到 >=22.19.0（node 20 已 EOL）

## 0.3.0 (2026-08-16)

### Features

* **首轮 bootstrap 锚定**（受 dsh-anchored-standard 启发）：请求 #1 只暴露真实
  Minimal 工具对（bash + str_replace_editor）并剥离自动注入上下文（技能目录
  提醒、AGENTS.md 摘要），把首轮轨迹锚定在极简条件上。首个持久 tool/call 或
  assistant/message 后晋升；阶段从持久会话事件推导，resume 安全；compaction
  重置阶段，压缩后回到 bootstrap 工具对 + 可配置压缩工作集直到新晋升信号。
  `bootstrap.maxTokens` 可选封顶首轮输出预算、晋升后剥离。

接线全部走宿主公开 waterfall：system-prompt/assemble（目录收窄）、
agent/pre-step（上下文剥离，prepend 注册保证最后执行）、agent/request（预算
封顶）、session/event（阶段供给）。任何过滤失败降级为完整目录，插件 bug 不会
拖垮会话。

## 0.2.2 (2026-08-16)

### Bug Fixes

* 经 typert-loader host artifact（lib/typert.host.js）注册配置网关端点，
  api-gateway 不再受模块实例身份影响：npm registry 安装时包内 typert-protocol
  副本与 harness 不同源，Remote 装饰器 SRC 标记对网关不可见，设置页调用报
  "transport failure ... HTTP 404"

## 0.2.1 (2026-08-16)

### Bug Fixes

* client bundle 挂载远程配置命名空间（修复 web boot "did not activate"）

## 0.2.0 (2026-08-15)

### Features

* 插件转为 DSH bundle 安装方式
