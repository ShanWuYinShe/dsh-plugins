# dsh-plugins — DSH host 层插件集

DeepSeek Harness（DSH）host 层全局插件 monorepo，包含官方级能力的 host 插件与 Web client 扩展。

| 插件包 | 核心功能 | 当前版本 | 适配 DSH |
|---|---|---|---|
| [`@chaoset/dsh-any-connect`](packages/dsh-any-connect/) | **多渠道桌面端与免密模型接入**：WorkBuddy（国内/国际版）、ZCode（Coding/Start Plan 双通道）、OpenCode Free 官方免密免费模型通道；支持思考强度自测与补全、积分倍率显示、图片多模态、自定义模型隐藏与 CLI 诊断 | `0.4.28-alpha.6` | `0.2.2-alpha.2` |
| [`@chaoset/provider-usage`](packages/provider-usage/) | **对话底栏模型额度指示器**：在输入框状态栏（composer dock）实时显示当前会话 provider 剩余额度与重置时间，点击展开可视化进度条与详细计费包；内置 8+ 种 Provider 查询器并提供开放注册 Seam | `0.2.1-alpha.5` | `0.2.2-alpha.2` |
| [`@chaoset/sandbox-extra-roots`](packages/sandbox-extra-roots/) | **沙盒额外允许写入目录**：为 `workspace-write` 沙盒安全追加工具缓存目录（npm/pip/cargo/go 等）；跨平台 Seatbelt/bwrap/Landlock 原生沙盒引擎注入；严格防范危险根与 TOCTOU 符号链接逃逸 | `0.4.28-alpha.4` | `0.2.2-alpha.2` |
| [`@chaoset/session-archive`](packages/session-archive/) | **归档会话完整生命周期管理**：Web 侧边栏专属归档面板与实时徽标；抽屉式**只读浏览**历史会话事件流；批量安全恢复到会话树；两段式彻底物理删除与落盘防竞态保护；纯前端毫秒级检索与排序 | `0.3.32-alpha.4` | `0.2.2-alpha.2` |

---

## 插件特性详解

### 1. @chaoset/dsh-any-connect — 多渠道桌面端与免密模型接入

接入各类桌面 AI Agent 与免密官方通道的模型到 DSH，无需手动配置复杂的 API Key，开箱即用。

- **多上游通道无缝接入**：
  - **WorkBuddy 国内版 (`workbuddy`)**：零配置自动读取本机桌面 App 登录态；深度支持 WorkBuddy 5.6+ 针对 `accessToken`/`refreshToken` 的 `$wbEncrypted` 加密信封（自动定位 macOS Bundle 或 Windows 注册表/安装目录的 Electron 二进制充当解密助手，亦支持 `WORKBUDDY_ELECTRON_BIN` 覆盖）；支持图片多模态输入；模型选择器以原生徽标标明积分倍率与限免标签（`/model` 弹窗在模型名后缀显示倍率，如 `· x0.79`）。
  - **WorkBuddy AI 国际版 (`workbuddy-ai`)**：独立接入国际版桌面 App，提供独立的「WorkBuddy AI」模型分组（GPT、Gemini 系列等）、独立凭据与账号积分卡片。
  - **ZCode Coding Plan (`zcode`)**：接入智谱 ZCode 桌面端 Coding Plan 官方渠道；按桌面端 `setting.json` 当前激活计划精准取用 API Key；以客户端本地内置白名单（`zcode-builtin.json`）动态约束模型，随客户端升级自动更新（智谱此前的 23:00–09:00 夜间免费限时活动已下线，现按 150% 额度与模型基准计费如实展示）。
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
  - 紧随 DSH 自带的 Token 消耗、步数、轮数指标并列展示，形如 `workbuddy 23 credits left`、`deepseek-official 45.2 cny 剩余`、`openrouter 5 credits left`；
  - 额度来源与对话框当前所选模型同源（`ctx.modelDirectories`），切换模型即刻自动联动切换额度 pill。
- **交互式额度抽屉 (Popover)**：
  - 点击底栏 pill 展开详细计费抽屉；
  - 每个计费包配有图形化进度条（`23 / 100`），颜色随余量分三档告警；
  - 明确展示套餐名称、额度余量/总量与重置时间。
- **全面的内置 Provider 查询器**：
  - **DeepSeek**：全面支持 DSH 0.2.1+ 官方的两条路由——`deepseek-account`（OAuth 账户余额与赠送代金券钱包）和 `deepseek-official`（API Key `GET /user/balance` 余额），亦兼容自定义 `deepseek` 路由；
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
  - 预置常用工具缓存一键快速添加（npm / bun / pip / cargo / go）；
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

本仓库通过 **GitHub Releases 分发**（Release 资产是标准 npm tarball），并额外提供 DSH 官方的「自定义插件索引」：索引与静态 npm registry 由 CI 从每个 Release 生成，发布在发行分支（当前 `alpha`，收敛后 `main`）根下的 `market/` 目录。下面两种方式任选，**推荐方式一**。

### 方式一：插件索引（推荐，发现页一键安装）

1. 打开 DSH → **插件** → **实验性插件**，打开 **自定义插件索引**（Custom plugin indexes）；插件页会出现**发现**标签页。
2. **发现** → **添加索引源**，填入：

   ```text
   https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/alpha/market/index.json
   ```

3. 在**发现**页浏览本仓四个插件并点**安装**（卡片显示的即与当前 DSH 兼容的最高版本）；进入插件页的**版本**列表可以安装任意历史版本。
4. **更新**：DSH 对自建 registry 的自动更新检查只在安装会话内生效（重启后「已安装」页查不到自建 registry 的新版本，这是 DSH 当前的设计限制）——
   - 安装后**同一会话内**：「已安装」页可直接点**更新**；
   - **重启 DSH 后**：用 CLI 把插件更新到指定版本（`<版本>` 见「发现」页或 Releases 页）：

     ```bash
     dsh plugin --profile web add @chaoset/dsh-any-connect@<版本> --registry=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/alpha/market/npm/
     ```

     provider-usage / sandbox-extra-roots / session-archive 把包名替换成 `@chaoset/<包名>` 即可。
5. 卸载：`dsh plugin --profile web remove @chaoset/<包名>`。

索引只提供元数据与安装来源（npm 包名 + 静态 registry），安装/更新仍走 DSH 自带的 pnpm 安装与 bundle 对账流程；索引收录的每个版本都对应本仓的一个 GitHub Release 资产。用索引安装时，插件的宿主运行时依赖由宿主 profile runner 的 runtime resolution 提供（不写入 profile 的 `node_modules`）；需要把依赖装进 profile 时请用下面的 tarball 方式。

> 当前索引随 `alpha` 适配线发布；收敛合入 `main` 后索引源 URL 的 `alpha` 段会换成 `main`，
> 届时会公告提醒已添加索引的用户一次性更新 URL。

索引**同时收录稳定线与预览线**，DSH 会按你的宿主版本自动区分：0.2.1 稳定版宿主默认安装/推荐各插件最高的稳定版，0.2.2 预览线宿主卡片显示并安装该线最高兼容预览版；版本列表里跨线的版本会标记「不兼容」且不提供安装按钮，不会装错线。

> 注：索引同时收录两条线时，预览线宿主（如 0.2.2-alpha.2）的版本列表不会给任何版本打「默认」标签（DSH 的默认版本只从兼容的正式版里选）；卡片上的版本与「安装」按钮仍是该宿主可用的最高兼容版本，功能正常。

### 方式二：tarball URL（手动）

Release 资产命名规则为 `chaoset-<包目录>-<版本>.tgz`，tag 名 `<包目录>-v<版本>`，可直接安装对应 URL：

```bash
# 版本以 Releases 页为准：https://github.com/ShanWuYinShe/dsh-plugins/releases

# 1. 安装 @chaoset/dsh-any-connect（模型接入）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/dsh-any-connect-v<版本>/chaoset-dsh-any-connect-<版本>.tgz

# 2. 安装 @chaoset/provider-usage（底栏额度显示）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/provider-usage-v<版本>/chaoset-provider-usage-<版本>.tgz

# 3. 安装 @chaoset/sandbox-extra-roots（沙盒额外目录）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/sandbox-extra-roots-v<版本>/chaoset-sandbox-extra-roots-<版本>.tgz

# 4. 安装 @chaoset/session-archive（归档会话管理）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/session-archive-v<版本>/chaoset-session-archive-<版本>.tgz

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

- **pnpm store 漂移（宿主升级后安装报错，全部 profile 通用）**：宿主升级若更换了内置 pnpm 的大版本，**每一个**旧 profile 的 `node_modules` 都是上一版 pnpm 安装的——只要该 profile 执行过 `dsh plugin add` 就会报 `ERR_PNPM_UNEXPECTED_STORE`（use the new store location …）：node_modules 里的 `.modules.yaml` 记录着旧 store 位置，与新 pnpm 解析出的不一致。**逐 profile 修复**，对每个受影响的 profile 各做一遍：

  修复就是**删掉重装**（node_modules 是纯安装产物，删掉连旧 store 记录一起归零；插件配置在 `cordis.patch.yml`，不受影响）：

  ```bash
  rm -rf $DSH_HOME/profiles/<name>/node_modules
  dsh plugin --profile <name> add <同一个 tarball URL>
  ```

  一次 `plugin add` 会按 package.json 把该 profile 已装的全部插件一并装回，store 位置直接写对。（2026-10-24 于宿主 0.2.1-rc.3 时代实测，当时内置 pnpm v11.28.5：web 与 desktop 两个 profile 各用一条命令重装四包；修复后核对 `node_modules/.modules.yaml` 的 `storeDir` 应指向 `$DSH_HOME` 内。）

### 给 AI Agent

若由 AI Agent 代为在环境中安装：目标环境已启用「自定义插件索引」时，优先引导用户在**发现 → 添加索引源**填入上面的索引 URL（见「方式一」），再在发现页安装；用命令行安装或指定版本更新时执行 `dsh plugin ...` 命令，**严禁手动编辑 `cordis.patch.yml`**：
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
bun run build           # 全仓构建：tsc 编译 host → 生成 Typert 工件 → esbuild 打包 client 与独立 CLI
bun run typecheck       # 类型检查：host + client 两套 tsconfig --noEmit
bun run test            # 运行 vitest 单元与集成测试
bun run test:ci         # build + typecheck + test 门禁验证（提交/发版前必跑）
bun run dsh-status      # 核对本地依赖基线 vs DSH 上游稳定/预发布线
bun run adapt <版本>    # dsh 宿主升级适配（--dry-run 预览，详见 RELEASING.md）
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
