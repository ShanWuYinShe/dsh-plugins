# dsh-plugins — DSH host 层插件集

DeepSeek Harness（DSH）host 层全局插件 monorepo，包含官方级能力的 host 插件与 Web client 扩展。

| 插件包 | 核心功能 | 当前版本 | 适配 DSH |
|---|---|---|---|
| [`@chaoset/dsh-any-connect`](packages/dsh-any-connect/) | **多渠道桌面端与免密模型接入**：WorkBuddy（国内/国际版）、ZCode（Coding/Start Plan 双通道）、OpenCode Free 官方免密免费模型通道；支持思考强度自测与补全、积分倍率显示、图片多模态、自定义模型隐藏与 CLI 诊断 | `0.5.1` | `0.2.2-rc.2` |
| [`@chaoset/provider-usage`](packages/provider-usage/) | **对话底栏模型额度指示器**：在输入框状态栏（composer dock）实时显示当前会话 provider 剩余额度与重置时间，点击展开可视化进度条与详细计费包；内置 8+ 种 Provider 查询器并提供开放注册 Seam | `0.3.1` | `0.2.2-rc.2` |
| [`@chaoset/sandbox-extra-roots`](packages/sandbox-extra-roots/) | **沙盒额外允许写入目录**：为 `workspace-write` 沙盒安全追加工具缓存目录（npm/pip/cargo/go 等）；跨平台 Seatbelt/bwrap/Landlock 原生沙盒引擎注入；严格防范危险根与 TOCTOU 符号链接逃逸 | `0.4.33` | `0.2.2-rc.2` |
| [`@chaoset/session-archive`](packages/session-archive/) | **归档会话完整生命周期管理**：Web 侧边栏专属归档面板与实时徽标；抽屉式**只读浏览**历史会话事件流；批量安全恢复到会话树；两段式彻底物理删除与落盘防竞态保护；纯前端毫秒级检索与排序 | `0.3.37` | `0.2.2-rc.2` |

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

本仓库通过 **GitHub Releases 分发**（Release 资产是标准 npm tarball），并额外提供 DSH 官方的「自定义插件索引」：索引与静态 npm registry 由 CI 从每个 Release 生成，作为站点发布在独立的发布产物分支 `market` 上（该分支根目录即站点根，URL 固定）。下面两种方式任选，**推荐方式一**。

### 方式一：插件索引（推荐，发现页一键安装）

0. **一次性前置**：在目标 profile 的 `.npmrc` 声明 `@chaoset` 的 scoped registry。**不配置时，重启 DSH 后的卸载/更新会回退默认 registry（npmjs）并报 `ERR_PNPM_META_FETCH_FAIL` 404**；配置后 GUI 与 CLI 都直接可用、CLI 不再需要 `--registry`：

   ```bash
   printf '@chaoset:registry=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/npm/\n' >> "$DSH_HOME/profiles/web/.npmrc"
   ```

1. 打开 DSH → **插件** → **实验性插件**，打开 **自定义插件索引**（Custom plugin indexes）；插件页会出现**发现**标签页。
2. **发现** → **添加索引源**，填入：

   ```text
   https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/index.json
   ```

3. 在**发现**页浏览本仓四个插件并点**安装**（卡片显示的即与你当前 DSH 版本精确匹配的最高版本）；进入插件页的**版本**列表可以安装历史版本（与你的宿主版本不匹配的会标「不兼容」并禁用安装）。**索引安装默认只下载并登记插件、不自动启用**：安装完成弹窗点**立即启用**（或在「已安装」列表打开开关），插件随即在线生效。
4. **更新**：配好第 0 步的 scoped registry 后，更新在**安装后同一会话内**和**重启 DSH 后**都可用——
   - GUI：**插件 → 已安装 → 插件详情 → 版本**，检查后点「更新到 `<版本>`」（重启后仍然有效）；
   - CLI：`dsh plugin --profile web add @chaoset/<包名>@<版本>`（不再需要 `--registry`）。
5. 卸载：GUI 用**插件 → 已安装 → 插件详情 → 卸载**；CLI 用 `dsh plugin --profile web remove @chaoset/<包名>`（配好第 0 步的 scoped registry 后不需要 `--registry`）。未配置 registry 的 profile 才需要临时补 `--registry=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/npm/` 兜底。

索引只提供元数据与安装来源（npm 包名 + 静态 registry），安装/更新仍走 DSH 自带的 pnpm 安装与 bundle 对账流程；索引收录的每个版本都对应本仓的一个 GitHub Release 资产。用索引安装时，插件的宿主运行时依赖由宿主 profile runner 的 runtime resolution 提供（不写入 profile 的 `node_modules`）；需要把依赖装进 profile 时请用下面的 tarball 方式。**因此本仓插件发布的 tarball 运行期零依赖**（`dependencies`/`optionalDependencies` 为空，宿主依赖只放 `devDependencies`）——否则 pnpm 会按 tarball 里的依赖声明去静态 registry 解析它们而 `ERR_PNPM_FETCH_404`，装过一个带运行期依赖的版本后，同一 profile 再装/更新其它插件会失败。

> 索引 URL 固定，添加一次永久有效：任一发布线（`alpha`、`rc`、正式版）发版后，同一个索引
> 都会自动更新，无需重新添加索引源。

索引里的每个版本都**精确声明它所匹配的 DSH 版本**（`engines.dsh` 是精确版本，不是范围），宿主按 SemVer range 判定兼容性；本仓声明精确版本，效果上等价于精确匹配：只有与你当前 DSH 版本完全一致的插件版本会显示可安装，其余版本在列表里标「不兼容」。因此 **DSH 每次升级（含同线 alpha→rc→正式版）后，请安装为那个新版本重新发布的插件版本**。

> 历史代价（如实说明）：0.2.2 适配线之前发布的 tarball 里 `engines.dsh` 是范围，索引按规则把它们 pin 到发布时适配的精确宿主版本（如 `0.2.1-rc.3`）。所以以 `0.2.1-rc.5` 为参考版本的宿主不会看到旧稳定版可安装——这是「精确匹配、不误导」的代价，收敛期发布对应版本后恢复。已发布 tarball 不可变，索引侧严格、安装期检查对历史版本仍宽松（CLI 仍可强制装旧包）。

> 注：预览线宿主（如 0.2.2-rc.2）下兼容版本可能全是预发布版，而 DSH 的「默认」标签只从兼容的正式版里选，因此卡片可能不打「默认」；「安装」按钮仍指向该宿主兼容的最高版本，功能正常。

> 运行期依赖的历史代价（如实说明，2026-10-30 实测）：2026-10-30T00:00:00Z 之前发布的旧 tarball
> 里仍带 `dependencies`（例如 `zod`），这些版本按「策略生效前只告警」的规则保留在索引里。若你
> 安装过这类旧版本，之后在同一 profile 再装/更新其它插件可能报 `ERR_PNPM_FETCH_404`（去静态
> registry 找 `zod` 等宿主依赖）。变通：先装好其它插件、把这类旧版本放在最后装；或改用「方式二」
> 的 tarball URL 安装旧版本（tarball 方式从常规 registry 解析依赖，不受影响）。这类版本无法回改，
> 但**策略生效之后发布的所有版本都强制运行期零依赖**（索引侧 check/build 自校验拦截）。

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

# 卸载插件（配好第 0 步的 scoped registry 后无需 --registry；未配置时才需要下面的 REGISTRY）
REGISTRY=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/npm/
dsh plugin --profile web remove @chaoset/dsh-any-connect --registry=$REGISTRY
dsh plugin --profile web remove @chaoset/provider-usage --registry=$REGISTRY
dsh plugin --profile web remove @chaoset/sandbox-extra-roots --registry=$REGISTRY
dsh plugin --profile web remove @chaoset/session-archive --registry=$REGISTRY
```

**生效时机**：启用 HMR 的 `web` profile 里，安装/启用/停用/卸载/更新都直接在线生效，无需重启（GUI 操作与 CLI 写 profile 后都会被运行中的实例通过 profile 监听重组合；只有结果明确报 `restart-required` 时才需要重启）。未启用 HMR 的 profile（如 headless/SDK）仍需重启后生效。

### 常见安装排障

- **重启后用 CLI 卸载/更新报 `ERR_PNPM_META_FETCH_FAIL`（`registry.npmjs.org/@chaoset/...: 404`）**：`pnpm remove` 会按默认 registry 校验/解析 lockfile 里来自自建 registry 的 tarball；`dsh plugin` 在常驻进程之外执行时拿不到「本进程安装该包时用的注册表」，回退到 pnpm 配置的默认 registry（npmjs）。处理：在 profile 目录配置第 0 步的 scoped `.npmrc`（一劳永逸，GUI/CLI 都恢复）；临时也可给命令补 `--registry=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/npm/`。

- **更新/卸载报「无法移除 X」+「其他配置仍在用这个组合包的组件，请先停用它们」**：这是 DSH 0.2.2-rc.1 插件管理器的已知误报，不代表真有别的配置在用它。管理器的卸载顺序是「取消选入 → 在线重组合 → 检查该组合包声明的行是否仍在运行 → `pnpm remove`」；当这次重组合只能等重启才生效（`restart-required`，例如运行时包目录/安装映射与磁盘不一致）时，宿主会先把这些行原地恢复并重启，紧接着的「行存活」检查就把它们误当成「其他配置仍在使用」。
  常见诱因：在插件管理器**之外**改动过 profile 依赖（手工编辑 `package.json`、删 `node_modules`、外部 `pnpm` 操作）后再安装/更新插件，安装映射与磁盘不一致。处理：重启 DSH（`dsh web`）后重新卸载/更新。失败不会回滚已写入的「取消选入」，若重启后仍看不到更新，按上面方式用 CLI 重新安装该插件（带 `--registry`）即可恢复。
  本仓四个插件的实现不会造成该状态：bundle patch 都是单行 `insert`、不创建 Loader 行、不写 profile 配置，因此「行还在运行」只能由宿主上述重组合恢复路径产生。

- **pnpm 供应链策略拦截安装**：pnpm v11 默认拦截依赖的构建脚本并启用「发布满 24 小时才可安装」策略。首次执行 `dsh plugin add` 若报错 `pnpm failed`：
  1. 打开目标 profile 目录（`$DSH_HOME/profiles/<name>/pnpm-workspace.yaml`）；
  2. 将 `allowBuilds` 占位的 `set this to true or false` 改为 `true`；
  3. 将刚发布的 `@chaoset/*@<版本>` 加入 `minimumReleaseAgeExclude` 列表；
  4. **重新执行一次 `dsh plugin add` 命令**（首次失败时 bundle 对账未完成，必须重跑以完成注册）。
  > ⚠️ 不要直接用 `pnpm add` 或手动写 profile 的 `package.json`：这样跳过了 bundle 对账，web 启动时会报 `pending (waiting for service: remote.xxx)`。

- **索引安装后，同 profile 再装/更新插件报 `ERR_PNPM_FETCH_404`（宿主依赖，如 `zod`）**：索引安装走静态 registry，pnpm 会按已装 tarball 的 `dependencies` 声明去该 registry 解析依赖；装过「历史版本仍带运行期依赖」的插件后，后续包操作就可能命中 404（详见上文「运行期依赖的历史代价」）。变通：
  1. 把该历史版本**放到最后装**（先装/更新其它插件），或直接改用「方式二」的 tarball URL 安装它；
  2. 若失败发生在 `dsh plugin add` 的 bundle 对账之后，**先停掉 `dsh web`**，删除该 profile 的 `node_modules` 后按同一顺序重装（见下一条「pnpm store 漂移」的删掉重装做法）；
  3. 策略生效时刻（2026-10-30T00:00:00Z）之后发布的版本运行期零依赖，不会再触发；发布侧由 `check`/build 自校验强制（该时刻之后发布的版本带运行期依赖即失败，见 `RELEASING.md`「收录规则」）。

- **pnpm store 漂移（宿主升级后安装报错，全部 profile 通用）**：宿主升级若更换了内置 pnpm 的大版本，**每一个**旧 profile 的 `node_modules` 都是上一版 pnpm 安装的——只要该 profile 执行过 `dsh plugin add` 就会报 `ERR_PNPM_UNEXPECTED_STORE`（use the new store location …）：node_modules 里的 `.modules.yaml` 记录着旧 store 位置，与新 pnpm 解析出的不一致。**逐 profile 修复**，对每个受影响的 profile 各做一遍。

  > ⚠️ **必须先停掉运行中的 DSH（`dsh web`）再做下面的删装**。运行中的实例里手动删 `node_modules` / 改 profile 依赖，会让宿主的运行时安装映射与磁盘不一致，之后在 GUI 里卸载/更新就可能命中 `restart-required` 并把「自己没停掉的行」误报成 `bundle-in-use`（见上一条排障）。

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
5. 索引页安装默认不启用：引导用户在弹出的安装结果里点**立即启用**（或「已安装」列表打开开关）；CLI 安装会同时写入 `dsh.profile.bundles`、默认启用。
6. 一般无需重启：启用 HMR 的 web profile 会在线重组合；只有结果报 `restart-required`（或 profile 未启用 HMR）时才重启。卸载/更新用 CLI 时务必带 `--registry`（见「常见安装排障」第一条）。
7. **禁止在管理器之外动 profile**：不要手工改 profile 的 `package.json` / `dsh.profile.bundles` / `cordis.patch.yml` / `pnpm-workspace.yaml`，不要在运行中的实例上删 profile 的 `node_modules` 或依赖。需要重建安装产物时先停掉 `dsh web`，装完再启动。否则宿主会进入 `restart-required`，GUI 里的安装/卸载/更新会报 `bundle-in-use`（「其他配置仍在使用…」）——插件实现本身无法绕过这个宿主状态。

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
