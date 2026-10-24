# dsh-plugins — DSH host 层插件集

DeepSeek Harness（DSH）host 层全局插件 monorepo，包含官方级能力的 host 插件与 Web client 扩展。

| 插件包 | 核心功能 | 当前版本 | 适配 DSH |
|---|---|---|---|
| [`@chaoset/dsh-any-connect`](packages/dsh-any-connect/) | **多渠道桌面端与免密模型接入**：WorkBuddy（国内/国际版）、ZCode（Coding/Start Plan 双通道）、OpenCode Free 官方免密免费模型通道；支持思考强度自测与补全、积分倍率显示、图片多模态、自定义模型隐藏与 CLI 诊断 | `0.4.23` | `0.2.1-rc.3` |
| [`@chaoset/provider-usage`](packages/provider-usage/) | **对话底栏模型额度指示器**：在输入框状态栏（composer dock）实时显示当前会话 provider 剩余额度与重置时间，点击展开可视化进度条与详细计费包；内置 8+ 种 Provider 查询器并提供开放注册 Seam | `0.1.12` | `0.2.1-rc.3` |
| [`@chaoset/sandbox-extra-roots`](packages/sandbox-extra-roots/) | **沙盒额外允许写入目录**：为 `workspace-write` 沙盒安全追加工具缓存目录（npm/pip/cargo/go 等）；跨平台 Seatbelt/bwrap/Landlock 原生沙盒引擎注入；严格防范危险根与 TOCTOU 符号链接逃逸 | `0.4.26` | `0.2.1-rc.3` |
| [`@chaoset/session-archive`](packages/session-archive/) | **归档会话完整生命周期管理**：Web 侧边栏专属归档面板与实时徽标；抽屉式**只读浏览**历史会话事件流；批量安全恢复到会话树；两段式彻底物理删除与落盘防竞态保护；纯前端毫秒级检索与排序 | `0.3.30` | `0.2.1-rc.3` |

---

## 插件特性详解

### 1. @chaoset/dsh-any-connect — 多渠道桌面端与免密模型接入

接入各类桌面 AI Agent 与免密官方通道的模型到 DSH，无需手动配置复杂的 API Key，开箱即用。

- **多上游通道无缝接入**：
  - **WorkBuddy 国内版 (`workbuddy`)**：零配置自动读取本机桌面 App 登录态；深度支持 WorkBuddy 5.6+ 针对 `accessToken`/`refreshToken` 的 `$wbEncrypted` 加密信封（自动定位 macOS Bundle 或 Windows 注册表/安装目录的 Electron 二进制充当解密助手，亦支持 `WORKBUDDY_ELECTRON_BIN` 覆盖）；支持图片多模态输入；模型选择器与 `/model` 弹窗直接标明积分倍率（如 `· x0.79`）与限免标签。
  - **WorkBuddy AI 国际版 (`workbuddy-ai`)**：独立接入国际版桌面 App，提供独立的「WorkBuddy AI」模型分组（GPT、Gemini 系列等）、独立凭据与账号积分卡片。
  - **ZCode Coding Plan (`zcode`)**：接入智谱 ZCode 桌面端 Coding Plan 官方渠道；按桌面端 `setting.json` 当前激活计划精准取用 API Key；以客户端本地内置白名单（`zcode-builtin.json`）动态约束模型，随客户端升级自动更新；支持 23:00–09:00 夜间免费时段自动识别与费率联动。
  - **ZCode Start Plan (`zcode-start-plan`)**：独立专属通道（`zcode.z.ai/api/v1/zcode-plan/anthropic`）与独立额度池；采用账号 JWT + 设备标识认证，扣减当日一次性 Token 包（过期不结转）；每日领取活动自动探测并在设置卡片中醒目提醒（提供一键复制 Plan ID）；动态跟随用户今日实际权益展示模型，未领取或过期如实隐藏。
  - **OpenCode Free (`opencode-free`)**：官方免密免费模型通道（Muse Spark 1.2/1.3、Qwen3.6 Plus、MiniMax 系列、Nemotron 3.5 Super VL、DeepSeek V4.1 Flash、Big Pickle 等）；自动过闸标头与 `read` 只读工具守卫注入，解除 "free tier can only be used from within OpenCode" 网关限制；多协议实时流式转码（OpenAI Responses、Anthropic Messages、OpenAI-compatible Chat Completions 统一转为标准 OpenAI SSE 流，完整支持 `reasoning_content` 思考过程输出）；自动读取本地官方 specs 缓存（`~/.cache/opencode/models.json`）决议精确上下文与多模态能力。
- **思考强度智能适配**：
  - 支持 low / medium / high / max 等思考等级选项，在 DSH 模型选择器即可切换；
  - 后台全自动探测与补测未声明档位的模型；
  - 对**只能在思考态工作**的模型（`onlyReasoning`），选择器「默认」档位智能补选最高档，OpenAI 通道补 `reasoning_effort`，Anthropic 通道补 `thinking` 预算对象并相应调整 `max_tokens`。
- **自定义模型管理与优雅体验**：
  - 设置页模型表格中支持点击删除图标**自定义隐藏/排除不常用模型**；
  - 表格上方展示已排除模型统计，提供一键「恢复默认」入口；
  - 完整展示模型名、费率倍率、真实与可选上下文窗口、思考档位与特性标签；
  - 与 DSH 原生主题视觉完美融合，刷新与状态切换平滑无抖动。
- **独立诊断 CLI**：
  - 附带 `dsh-any-connect doctor`（体检凭据、加密格式、解密助手、心跳与模型数）、`status`、`logout` 命令，支持 `--provider <id>` 针对指定渠道排查。

---

### 2. @chaoset/provider-usage — 对话底栏模型剩余额度指示器

在对话区底部的状态栏（composer dock）直观显示当前会话 provider 的剩余额度、余额与重置周期。

- **Composer Dock 状态栏原生呈现**：
  - 紧随 DSH 自带的 Token 消耗、步数、轮数指标并列展示，形如 `workbuddy · 23 credits left`、`DeepSeek · ¥45.20`、`OpenRouter · $5.00 left`；
  - 额度来源与对话框当前所选模型同源（`ctx.modelDirectories`），切换模型即刻自动联动切换额度 pill。
- **交互式额度抽屉 (Popover)**：
  - 点击底栏 pill 展开详细计费抽屉；
  - 每个计费包配有字符级与图形化进度条（`▓▓▓▓▓░░░░░ 23 / 100`）；
  - 明确展示套餐名称、额度余量/总量、重置倒计时与阶梯限额。
- **全面的内置 Provider 查询器**：
  - **DeepSeek**：全面支持 DSH 0.2.1+ 官方的两条路由——`deepseek-account`（OAuth 账户余额与赠送代金券钱包）和 `deepseek-official`（API Key `GET /user/balance` 现金与代金券），亦兼容自定义 `deepseek` 路由；
  - **OpenRouter**：`/api/v1/key` + `/api/v1/credits`，API Key 自身限额优先，回落到账户额度；
  - **Moonshot (Kimi)**：`GET /v1/users/me/balance` 可用余额、现金、代金券分列；
  - **SiliconFlow (硅基流动)**：`GET /v1/user/info` 总额、可用、充值分列；
  - **BigModel (智谱)**：`GET /api/monitor/usage/quota/limit` Coding Plan 滚动窗口与订阅套餐；
  - **MiniMax**：`GET /v1/token_plan/remains` 5 小时滚动窗口与周额度窗口；
  - **OpenAI / OneAPI**：`GET /dashboard/billing/subscription` 余额与限额用量；
  - **OpenCode / OpenCode Go**：`GET /usage` 滚动、周、月窗口用量百分比。
- **开放查询器注册架构 (Seam)**：
  - 宿主服务暴露 `ctx.providerUsage`，任何第三方 provider 插件均可通过 `register()` 挂载自有查询器（覆盖重写语义，支持热重载）；
  - `@chaoset/dsh-any-connect` 自动通过此机制注入 WorkBuddy 与 ZCode 的额度查询。
- **稳健的高可用设计**：
  - **绝不消耗额度**：仅调用只读余额接口；
  - **并发单飞与缓存**：60s 本地缓存 + 并发单飞合并，多个组件读取共用一次请求；
  - **敏感信息脱敏**：请求失败保留上次成功快照，报错信息严格脱敏（过滤 JWT、`sk-` 密钥与 URL 参数凭据）；
  - **会话搁置自愈**：防范窗口长期失焦休眠后的数据滞后，激活时具备唤醒恢复机制；
  - **延迟就绪挂载**：严格等待模型目录服务就绪后再注册 slot，杜绝宿主缓存 `undefined` 导致整页丢失 pill。

---

### 3. @chaoset/sandbox-extra-roots — 沙盒额外允许写入目录

为 DSH 的 `workspace-write` 沙盒模式安全追加用户指定的写入白名单，解决工具缓存无权写入的痛点。

- **解决开发痛点**：
  - DSH 的 `workspace-write` 沙盒模式默认严格限制命令仅能写入 workspace 根目录与系统 `/tmp`，使 npm、pip、cargo、go、uv 等工具的全局缓存因无权写入而报错。
- **追加式白名单**：
  - 官方安全白名单始终严格保留，只追加用户明确配置的额外允许写入目录。
- **跨平台原生沙盒多引擎适配**：
  - **macOS**：重构 Seatbelt (SBPL) profile，安全注入允许写入子路径；
  - **Linux**：在官方 profile 基础上安全插入 bwrap `--bind` 与 Landlock `--rw`；
  - **Windows**：识别 ACL runner 限制并提供清晰友好的单次告警；
  - **FS Fence**：扩展 `checkedTarget` 文件系统围栏，对额外目录安全放行。
- **多层次安全防护**：
  - **绝对禁止危险根**：严禁将 `/`、盘根、用户主目录本身及其父目录（如 `/Users`、`/home`）设为可写；
  - **系统关键路径过滤**：自动忽略操作系统核心目录（`/etc`、`/usr`、`/bin`、`/sbin`、`/private`）；
  - **TOCTOU 符号链接防御**：运行时动态解析软链接真实目标，一旦被替换为危险根立即剔除权限。
- **可视化配置与即时热生效**：
  - 设置页「插件配置」提供专属卡片，支持路径实时校验预览与错误提示；
  - 预置常用工具缓存一键快速添加（npm / pip / cargo / go）；
  - 经官方 config-editor 直接保存到 `cordis.patch.yml`，修改即时热生效，无需重启。

---

### 4. @chaoset/session-archive — 归档会话完整生命周期管理

补全 DSH 仅有「归档动作」而缺失后续查看、恢复、检索与清理的断环，提供完整的会话归档管理。

- **Web 侧边栏专属面板与动态徽标**：
  - 侧边栏底部添加「归档」图标入口；
  - 徽标实时显示当前有效归档会话数量（轻量订阅 + 轮询兜底）。
- **历史会话只读抽屉浏览**：
  - 会话列表展示标题、原工作区路径、时间、占用磁盘大小；
  - 点击任意会话可展开抽屉式**只读浏览**完整用户与助手消息，内置安全截断与字符保护，无需恢复即可回溯历史上下文。
- **批量一键安全恢复**：
  - 支持多选会话一键恢复到原工作区的会话树；
  - 针对底层文件被删除等异常孤儿会话，返回逐条精确的原因诊断。
- **彻底物理删除与安全防竞态**：
  - 两段式防误删确认（首次点击进入确认态，4 秒内二次确认执行）；
  - 干净清理底层会话持久化数据与目录；
  - 沉降观察窗检测：若会话正处于活跃生成落盘中，严正拒绝删除，防止数据损坏；
  - 内存会话占位墓碑机制：防止删除后的内存残留会话复活，对内存尚未消亡的会话明确提示 `needsRestart`。
- **高效检索与状态记忆**：
  - 纯前端即时关键字搜索（标题、工作区路径、会话 ID）；
  - 多维度排序（修改时间、体积大小、标题名称）；
  - sessionStorage 状态记忆：刷新页面不丢失当前的搜索词与排序规则；
  - 分页流式加载，海量归档会话渲染零卡顿。
- **Remote API**：
  - 暴露 `ctx.remote.sessionArchive`（支持 `list()`、`count()`、`detail(id)`、`delete(ids)`、`unarchive(ids)`）。

---

## 安装与使用

推荐使用 DSH 自带的 `dsh plugin` 命令安装：它会自动调用 pnpm 安装依赖，将包加入 `dsh.profile.bundles`，并由 DSH 应用包内自带的 `cordis.patch.yml` 完成插件注册。

本仓库通过 **GitHub Releases 分发**。Release 资产为标准 npm tarball（命名规则：`chaoset-<包名>-<版本>.tgz`，tag 名 `<包名>-v<版本>`），公开仓库直接安装对应 URL 即可：

```bash
# 查看 Releases 列表获取最新版本：https://github.com/ShanWuYinShe/dsh-plugins/releases

# 1. 安装 @chaoset/dsh-any-connect（模型接入）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/dsh-any-connect-v0.4.19/chaoset-dsh-any-connect-0.4.19.tgz

# 2. 安装 @chaoset/provider-usage（底栏额度显示）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/provider-usage-v0.1.10/chaoset-provider-usage-0.1.10.tgz

# 3. 安装 @chaoset/sandbox-extra-roots（沙盒额外目录）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/sandbox-extra-roots-v0.4.24/chaoset-sandbox-extra-roots-0.4.24.tgz

# 4. 安装 @chaoset/session-archive（归档会话管理）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/session-archive-v0.3.28/chaoset-session-archive-0.3.28.tgz

# 从本地源码安装（开发调试时使用绝对路径）
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/dsh-any-connect

# 卸载插件
dsh plugin --profile web remove @chaoset/dsh-any-connect
dsh plugin --profile web remove @chaoset/provider-usage
dsh plugin --profile web remove @chaoset/sandbox-extra-roots
dsh plugin --profile web remove @chaoset/session-archive
```

安装后**重启 DSH harness**（例如 `dsh web`）生效。

### 常见安装排障

- **pnpm 供应链策略拦截安装**：pnpm v11 默认拦截依赖的构建脚本并启用「发布满 24 小时才可安装」策略。首次执行 `dsh plugin add` 若报错 `pnpm failed`：
  1. 打开目标 profile 目录（`$DSH_HOME/profiles/<name>/pnpm-workspace.yaml`）；
  2. 将 `allowBuilds` 占位的 `set this to true or false` 改为 `true`；
  3. 将刚发布的 `@chaoset/*@<版本>` 加入 `minimumReleaseAgeExclude` 列表；
  4. **重新执行一次 `dsh plugin add` 命令**（首次失败时 bundle 对账未完成，必须重跑以完成注册）。
  > ⚠️ 不要直接用 `pnpm add` 或手动写 profile 的 `package.json`：这样跳过了 bundle 对账，web 启动时会报 `pending (waiting for service: remote.xxx)`。

- **pnpm store 漂移（宿主升级后安装报错）**：宿主升级若更换了内置 pnpm 的大版本，旧 profile 的 `node_modules` 是上一版 pnpm 安装的，`dsh plugin add` 会报「use the new store location … installed with a different major version of pnpm」。修复（在目标 profile 目录重装依赖，配置文件不动）：

  ```bash
  cd $DSH_HOME/profiles/<name>
  CI=true '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --expose-internals '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs' install
  ```

  `CI=true` 跳过「清空 modules 目录」的 TTY 确认（node_modules 是可重建产物，已加载模块在内存不受影响）。**若 install 显示 `Already up to date`，store 记录并未重写——加 `--force` 强制重链**，然后核对 `node_modules/.modules.yaml` 的 `storeDir` 已指向 `$DSH_HOME` 内的新 store，再重跑一次 `dsh plugin add`。（2026-10-24 实测：宿主 0.2.1-rc.3 内置 pnpm v11.28.5，web 与 desktop 两个旧 profile 均以此修复后安装四包。）

### 给 AI Agent

若由 AI Agent 代为在环境中安装，请直接执行 `dsh plugin ...` 命令，**严禁手动编辑 `cordis.patch.yml`**：
1. 确认 `dsh` 与 `pnpm` 处于 PATH 中；
2. 确定目标 profile（默认为 `web`）；
3. 执行 `dsh plugin --profile web add <tarball URL>`；
4. 验证安装：`dsh plugin --profile web list` 或 `dsh --profile web --dump-config | grep chaoset`；
5. 重启 DSH。

---

## 开发

本项目采用 Bun 作为包管理器（由根目录 `packageManager` 锁定），所有包源码均采用 TypeScript 开发。

```bash
bun install             # 安装依赖（切分支后记得重新 install）
bun run build           # 全仓构建：tsc 编译 host (src/ -> lib/)，esbuild 打包 client
bun run typecheck       # 类型检查：host + client 两套 tsconfig --noEmit
bun run test            # 运行 vitest 单元与集成测试
bun run test:ci         # build + typecheck + test 门禁验证（提交/发版前必跑）
bun run dsh-status      # 核对本地依赖基线 vs DSH 上游稳定/预发布线
bun run gate            # 发布门禁干跑（检查 tag 与待发布包）
bun run audit           # 依赖漏洞审计（基于 OSV.dev）
```

---

## 分支与版本规范

- **双分支跟随策略**：
  - **待命期**（DSH 处于稳定线）：无 `alpha` 分支，所有功能与修复直接在 **`main`** 分支推进，版本号为**纯 semver 正式版**（如 `0.4.19`），发布正式 Release。
  - **活跃期**（DSH 开启高于当前正式版的新 `-alpha` 线）：从 `main` 拉出 **`alpha`** 分支，版本号为 `-alpha.N`（进 rc 后换 `-rc.N`），发布预发布 Release。
  - **收敛期**：DSH 发完最新 rc 正式转正后，在 `alpha` 适配去后缀转正，压缩合入 `main`，发正式 Release 并彻底删除 `alpha` 分支。
- 完整的发布流程、推送门禁与分支纪律详见 [RELEASING.md](RELEASING.md)。
