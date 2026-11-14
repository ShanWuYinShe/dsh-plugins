# @chaoset/dsh-any-connect — DSH 多渠道模型接入插件

将各类桌面 Agent（WorkBuddy 国内版/国际版、ZCode Coding Plan / Start Plan）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用丰富的大模型资源。

> **来源说明**：本包最初源自 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）的独立分支，在 @chaoset 组织下独立演进。命名取 `any-connect`（anyconnect），旨在将更多桌面 Agent 与免费通道模型统一无缝接入 DSH。上游实现的方法论（variant 数据驱动、App 文档 UA 形态、促销生效规则等）经实测验证后移植于此，致以谢意。

---

> 展示口径（DSH 0.2.2 起）：模型选择器与 `/model` 弹窗里的「免费」等徽标由宿主
> **原生渲染**本插件适配器提供的 `badge`（`{en, zh}` 本地化、按 tone 着色）；插件不再
> 向 `conversation.input.model.label` 贡献组件，也不再往模型名里拼中文「免费」。计费倍率
> 仍拼在 `name` 上（如 `GLM-5.2 · x0.79`），因为宿主 `/model` 弹窗只读 `name`。

## 支持通道与功能

- **多通道模型聚合接入**：
  - **WorkBuddy 国内版 (`workbuddy`)**：安装并登录 WorkBuddy 桌面 App 即可零配置使用。全面支持 WorkBuddy 5.6+ 的 `$wbEncrypted` 加密凭据（自动定位 macOS Bundle 或 Windows 注册表/安装目录的 Electron 二进制充当解密助手）。
  - **WorkBuddy AI 国际版 (`workbuddy-ai`)**：独立接入国际版桌面 App，独立提供「WorkBuddy AI」模型分组（GPT、Gemini 系列等）、独立凭据与账号积分卡片。
  - **ZCode Coding Plan (`zcode`)**：接入智谱 ZCode 桌面端 Coding Plan 官方渠道；按桌面端 `setting.json` 当前激活计划精准取用 API Key；以客户端本地内置白名单（`zcode-builtin.json`）动态约束模型（智谱此前的 23:00–09:00 夜间免费限时活动已下线，现按 150% 额度与模型基准计费如实展示）。
  - **ZCode Start Plan (`zcode-start-plan`)**：独立专属通道（`zcode.z.ai/api/v1/zcode-plan/anthropic`）与独立一次性 Token 额度池；采用账号 JWT + 设备标识认证；每日领取活动自动探测并在设置卡片中醒目提醒（提供一键复制 Plan ID）；动态跟随用户今日实际权益展示模型，未领取或过期如实隐藏。

- **图片输入（多模态）**：
  - 按上游逐模型声明的能力放行图片——绝大多数多模态模型（含 GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）可直接在对话框粘贴或拖入图片；纯文本模型按上游声明如实提示不支持。

- **思考强度智能适配**：
  - 按上游每个模型声明的 `supportedEfforts` 提供思考等级选项（如 GLM-5.3 支持 low / high / max），在 DSH 模型选择器里即可切换，请求以 `reasoning_effort` 转发；
  - 后台全自动检测与补测未声明档位的模型（每模型仅少量真实请求），测出真实校验档位即进入选择器；
  - 选择器的「默认」档对**只能在思考态工作**的模型（上游 `onlyReasoning`）智能补具体档位（优先 `high`，无则取最高档）；OpenAI 通道补顶层 `reasoning_effort`，Anthropic 通道补 `thinking` 预算对象（`enabled` + `budget_tokens` 并相应抬高 `max_tokens`）。

- **费率比例与限免标注**：
  - composer 模型选择器以 DSH 0.2.2 原生徽标（`LlmModelInfo.badge`）标注每个模型：免费模型绿色 `Free` 徽标、上游促销活动蓝色 info 徽标、积分倍率灰色中性徽标（如 `GLM-5.2 ·x0.79`）；
  - `/model` 弹窗由模型名后缀显示倍率（如 `GLM-5.2 · x0.79`）；
  - 状态卡片实时跟随上游标记当前免费 / 限时免费 / 夜间折扣模型。

- **今日积分消耗统计（WorkBuddy）**：
  - WorkBuddy 的积分是「裂变包」制（上游每天发一个新包、旧包到期整包消失），「当前积分」每天双向跳动，单看一个时刻读不出今天花了多少；
  - **额度窗口与单位随 DSH 语言切换**：窗口名（如「5 小时 / 7 天 / 工具调用」）与单位
    （次 / 有效 / 官方免费）以本地化结构交给 provider-usage，中文界面显示中文、英文界面
    显示英文（含 1 hour / 5 hours 单复数）；
  - 插件对每次成功查询积分做采样差分记账（今日已用 / 今日发放 / 今日峰值），在额度 pill（展开后「今日已用」行）、配置页卡片（今日统计 + 近 7 日每日消耗）与 `status` CLI 三处展示；
  - 口径为**估算**：只有 DSH 运行且轮询到查询时才有样本，两次采样之间「发放+消耗」抵消的量会被低估；跨天首观测不计差分（无法归属到哪一天，宁少不虚记）。今日峰值即稳定的「今天的总额度基准」（今日已用 ≈ 峰值 − 当前剩余）。

- **自定义模型管理**：
  - 设置页模型列表中支持点击「删除」按钮**自定义隐藏/排除不常用模型**；
  - 卡头展示隐藏计数；展开卡片后下方有独立的「已隐藏的模型」区，列出每个被隐藏
    模型的名称、倍率、上下文窗口与思考档位，并带**逐条「恢复」按钮**——只放回想
    要的那几个，其余隐藏项保持不动；
  - 「全部恢复」仍然保留，作为「清空重来」的出口（按钮 title 已说明其影响范围）；
  - 模型清单可随时折叠/展开，清晰列出倍率、最大/备选上下文窗口、思考档位与特性标签。

---

## 安装

### 方式一（推荐）：插件索引

启用 DSH 的「自定义插件索引」实验性 bundle 后，在**发现 → 添加索引源**填入：

```text
https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/index.json
```

即可在发现页一键安装本插件、查看与安装任意历史版本（索引与静态 registry 由 CI 从
GitHub Releases 生成，发布在独立的 `market` 发布产物分支根目录（CI 生成，禁止手工编辑））。

**首次使用前（一次性）**：在目标 profile 的 `.npmrc` 里声明 `@chaoset` 的 scoped registry。不配置时，重启 DSH 后
GUI/CLI 的卸载与更新会回退默认 registry（npmjs）并报 `ERR_PNPM_META_FETCH_FAIL` 404：

```bash
printf '@chaoset:registry=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/market/npm/\n' >> "$DSH_HOME/profiles/web/.npmrc"
```

配置后，安装/启用/停用/卸载/更新都可在 GUI 完成（重启后同样可用，`已安装 → 插件详情 → 版本` 可直接更新）；
CLI 也不再需要 `--registry`：

```bash
dsh plugin --profile web add @chaoset/dsh-any-connect@<版本>
dsh plugin --profile web remove @chaoset/dsh-any-connect
```

### 方式二：tarball URL（手动）
> 适配的 DSH 版本见本包 `package.json` 的 `engines.dsh` 字段（官方兼容声明：无破坏性变更的适配为同线兼容范围，宿主线内的 rc 都可安装）；仓库的 `dsh-v*` git tag 是各次稳定版适配的归档点。

前置条件：需在本机安装并登录对应桌面 App（插件自动复用 App 的登录状态，账号切换自动跟随）。

```bash
# 推荐使用 DSH plugin 命令安装（唯一官方支持的界面为 Web）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/dsh-any-connect-v0.4.27/chaoset-dsh-any-connect-0.4.27.tgz
dsh web

# 从本地源码安装
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/dsh-any-connect

# 卸载
dsh plugin --profile web remove @chaoset/dsh-any-connect
```

`<版本>` 以 [Releases 页](https://github.com/ShanWuYinShe/dsh-plugins/releases)为准。启用 HMR 的 web profile 会在线重组合，安装/启停/卸载/更新无需重启。

> **运行时依赖**：本包不再自带 `@earendil-works/pi-ai` 副本（原 optionalDependency 会装出第二份
> pi-ai 实例与整棵传递依赖）。pi-ai 随宿主 `dsh-llm-pi-ai` 的依赖闭包解析，与本插件共享同一
> 实例（宿主 profile runner 的 runtime resolution），既保证单实例，也避免重复安装。

> 给 AI agent：直接执行 `dsh plugin ...` 命令即可，不要手动编辑 `cordis.patch.yml`。

---

## CLI 诊断工具

包附带 `dsh-any-connect` 命令，用于快速排查各渠道登录态与宿主健康：

```bash
dsh-any-connect doctor     # 全面体检（凭据、登录态、加密助手、宿主心跳、内置兜底名单数量）
dsh-any-connect status     # 当前登录态与积分/额度
dsh-any-connect logout     # 移除本插件的凭据副本（不动桌面 App 的登录）
```

该命令是构建期打出的**自包含单文件**（`lib/bin.js`，内联依赖、仅保留 `node:` 内建
模块）：独立 node 进程即可运行，不依赖宿主包的模块解析路径，也不受当前工作目录影响
——从 profile 的 `node_modules/.bin` 调用与 `node <包目录>/lib/bin.js` 直接调用等价。
内联的第三方组件与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

默认操作 WorkBuddy 国内版；使用 `--provider <id>` 切换操作对象（`workbuddy`、`workbuddy-ai`、`zcode`、`zcode-start-plan`）：

```bash
dsh-any-connect status --provider workbuddy-ai
dsh-any-connect doctor --provider workbuddy-ai
dsh-any-connect status --provider zcode
dsh-any-connect status --provider zcode-start-plan
```

---

## 配置与系统探测

| 字段 | 默认值 | 说明 |
|---|---|---|
| `authFile` | 自动探测 | 显式指定 WorkBuddy 国内版桌面凭据文件路径（覆盖环境变量与平台默认探测） |
| `authFileAI` | 自动探测 | 同上，作用于 WorkBuddy AI（国际版） |
| `authFileZCode` | 自动探测 | 同上，作用于 ZCode 桌面端凭据文件（覆盖环境变量与平台默认探测） |
| `zcodeBuiltinConfig` | 自动探测 | ZCode Coding Plan 白名单文件（`zcode-builtin.json`）路径；未设置时回退 `ZCODE_BUILTIN_CONFIG` 环境变量与客户端内置位置 |

> 本插件的四个渠道**不会**出现在 DSH「设置 → 模型」页：它们没有可填写的 provider profile
> （凭据来自桌面 App），声明进去只会得到一张空的编辑卡片。配置面统一在
> **「设置 → 内置插件 → dsh-any-connect」的插件卡片**（模型隐藏、额度、今日统计等）以及上表
> 的 `cordis.patch.yml` 高级字段；模型选择器照常可用，无需任何额外配置。

### 凭据来源探测顺序与跨系统支持

- **WorkBuddy**：macOS / Linux 原生路径、Windows 的 Local → Roaming AppData、WSL 下挂载的 Windows 用户目录；亦可用 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE` 环境变量显式指定。
  - **WorkBuddy 5.6+ 的加密凭据**：桌面端自 5.6 起把 `accessToken` / `refreshToken` 以 `$wbEncrypted` 信封加密落盘，解密密钥只存在于其自身的 Electron 进程内。插件自动定位 App 可执行文件充当解密助手：macOS 按 bundle id 检索并校验身份，Windows 探测默认安装目录（`%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`）及卸载注册表。自动定位不成功时，可用 `WORKBUDDY_ELECTRON_BIN`（国内版）或 `WORKBUDDY_AI_ELECTRON_BIN`（国际版）显式指定 App 主程序，**设置后需完全退出并重启 DSH**。
  - **诊断未登录问题**：`dsh-any-connect doctor --json` 会报告 `desktopAuthFile.present`、`desktopAuthFile.format` 与 `atRestHelper`。若格式为 `encrypted` 但助手不可用，按引导设置上述环境变量即可。
- **ZCode**：macOS（`~/.zcode/v2/credentials.json` 及 `Library/Application Support`）、Windows（`%USERPROFILE%\.zcode\v2\credentials.json` 及 Local/Roaming AppData）、WSL（优先通过 WSL 挂载探测 Windows 宿主用户目录与 AppData，并自动计算跨系统解密密钥，随后回落 Linux 原生目录）、Linux（`~/.zcode/v2/credentials.json` 及 `~/.config`）；亦可用 `ZCODE_AUTH_FILE` 环境变量显式指定。
  - **Coding Plan 与 Start Plan 是两个独立连接**：`zcode` 与 `zcode-start-plan` 各自拥有独立的模型分组、模型名单、额度池与请求通道；
  - **Coding Plan 白名单**：以本机 ZCode 客户端内置目录（`zcode-builtin.json` 的 `builtinModelIds`）为白名单，随客户端发版自动更新（当前为 GLM-5.3、GLM-5.3-Flash）；可用 `zcodeBuiltinConfig` 配置项（`cordis.patch.yml`）或 `ZCODE_BUILTIN_CONFIG` 环境变量显式指定该文件路径（配置优先）；
  - **Start Plan 专属通道与每日领取**：走 `zcode.z.ai/api/v1/zcode-plan/anthropic`，扣减一次性 token 包；每日领取需通过客户端完成，插件每天自动探测可领活动并在卡片醒目提示；
  - **夜间免费限时活动已下线**：智谱此前的 23:00–09:00 夜间免费窗（曾为 Coding Plan 专属权益，Start Plan 不享受）已下线，插件已移除夜免徽标与费率改写，模型按 150% 额度与基准计费如实展示。

### 上游限流（429）的记录与展示

模型通道被上游限流时，插件把观测**落到台账**（`rate-limit.ts`）；带明确恢复时刻的
观测还会经宿主 storageDomain（`storages/dsh_any_connect/` 的 `rate_limits` 表）持久化，
**DSH 重启后仍会继续提示**（没有恢复时刻的观测只活在本进程的 TTL 里）。台账在两处
如实展示：配置页卡片（「上游限流中」提示框）与 composer 的额度 pill。

**台账只观测、不拦截**：它不参与任何请求门禁，也不会因为「上次被限」而拒绝
后续请求。请求是否放行完全由上游决定——插件的职责只是把上游说过的话显示出来，
不是替上游做决定；卡片与 pill 也明确写出这一点。一次成功请求只清掉**它自己
那个模型**的观测（解除由上游事实驱动，不靠推算）。

**限流按模型分账**：WorkBuddy / WorkBuddy AI 的频率限制是**按模型**的（官方
客户端把 cap-hit 以 modelId 为键记录，错误文案也提示「或换其它模型继续」），
不是整个 provider 共享。因此台账按 `provider + model` 分行：

- A 模型被限时，B 模型仍可正常调用（插件不会替上游拦掉 B）；
- A 的请求成功也不会清掉 B 的观测，两个模型的恢复时刻互不覆盖；
- 卡片**一个模型一个框**（列出该 provider 下全部被限模型）；额度 pill 的 wire 同样
  携带**全部**被限模型（逐模型数组），但界面只显示**当前选中模型**那一条（没有就
  不显示）——切回先前被限的模型时它的信息不会丢，也不会把别的模型的限流挂到当前
  模型上。

**限流策略也分账**：同一个模型可能同时被多条策略约束（RPM / TPM / 日额度…），
台账行键是 `provider + model + policy`，一条策略一条观测、互不覆盖。上游披露
`policy` / `metric` / `limit` / `remaining` / `windowSeconds` 时，卡片与 pill 会补一行
策略详情（如 `rpm · 0 / 60 · 60 秒窗口`）；pill 头行只挑当前模型**最紧迫**的一条
（余量已耗尽 > 恢复更早 > 最近被拒），同模型的其它策略仍在 wire 与卡片里可查。

口径只有一条：**恢复时刻与策略数字只来自上游明说的事实**。

- 标准头：IETF `RateLimit` / `RateLimit-Policy`（`t`/`w` 是 **delta 秒**）、旧版独立头
  `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`（delta 秒）；
- 事实标准头：`Retry-After`（RFC 9110：相对秒 / HTTP-date）、`X-RateLimit-Reset`
  （epoch 秒或毫秒）；厂商头：OpenAI 风格 `x-ratelimit-*-{requests,tokens}`（reset 是
  时长串）与 Anthropic 风格 `anthropic-ratelimit-<metric>-{limit,remaining,reset}`
  （reset 是 RFC3339）；**只有 `remaining === 0` 的厂商策略才解释得通 429**；
- 错误正文里的时刻也算。WorkBuddy `code:6004` 的文案形如
  `your usage will reset at 2026-10-30 14:20:02 UTC+8`；官方客户端对时区后缀
  是**可选**的（缺失时按 UTC+8 上海壁钟解释），插件采用同一口径，同时接受
  `UTC+08:00` / `(UTC+8)` / `T` 分隔与中文文案（`将于 … 后恢复`）；正文出现
  多个时刻时取离 reset/重置/恢复 最近的那个；
- 上游没给 → 显示「已被限 {时长}，上游未提供恢复时间」，并给出被拒次数与模型名。
  **绝不按固定窗口推算倒计时**。

聊天里的 429 错误文案同样标注范围：WorkBuddy 会写「该限制仅针对模型 `{model}`，
其它模型仍可继续使用」；智谱的并发限流（1302/1305）是订阅档位维度、不按模型，
不写这句，避免误导。

各上游的公开口径：

| 上游 | 限流维度 | 是否给恢复时刻 |
| --- | --- | --- |
| GLM Coding Plan（`zcode`） | 按订阅档位的**并发数**，平台动态调整；另有每 5 小时 / 每周**积分**额度 | 并发限流**不给**；积分额度走额度通道，由窗口自带的 `resetsAt` 表达（5 小时积分按消耗时刻滚动刷新） |
| ZCode Start Plan | 一次性 token 池（按模型分池） | 池子的 `expiredAt` 走额度窗口 |
| WorkBuddy / WorkBuddy AI | **按模型**的频率限制（`code:6004`；官方客户端按 modelId 记 cap-hit，错误文案建议切换其它模型）；计费包积分制 | 6004 在错误正文里写恢复时刻（`reset at <时间> UTC+8`，时区后缀可省略） |

配套的错误分类修正：智谱把欠费（`1113`）、套餐到期（`1309`）、无模型权限
（`1311`）、风控封禁（`1313`）和**真限流**（`1302`/`1305`）全都塞进 HTTP 429，
只有真限流值得重试。`classifyUpstreamError` 现在按 `"code"` 字段区分，其余按
限流重试会永远等不到成功。

---

## 数据与文件位置

插件在 DSH home（默认 `~/.dsh`，可被 `$DSH_HOME` 覆盖）内维护三处数据，不再向 home 根目录平铺散文件：

| 位置 | 内容 | 说明 |
|---|---|---|
| `storages/dsh_any_connect/auth/` | 各变体的自有凭据副本（每变体一个 JSON） | 宿主存储域（storageDomain）：schema 校验、原子写、损坏记录自动备份。桌面端凭据可读时通常为空。 |
| `.dsh-any-connect/` | `zcode-device-mid` 设备标识；存储域不可用时的凭据副本文件回落 | 正常情况只有设备标识一个文件。 |
| `cache/dsh-any-connect/` | 模型目录 ×5、档位探测结果、桌面版本记录、host 心跳 | 可再生缓存，删除后自动重建。 |
| `cache/dsh-any-connect/<variant>-excluded-models.json` | 用户在各变体卡片里「删除 / 隐藏」的模型清单 | **用户意图，不是可再生缓存**：删除该文件会恢复所有已隐藏模型。 |

> **升级说明（0.4.28 起）**：旧版平铺在 home 根目录的散文件（`.workbuddy-auth.json` 等）
> **不再自动迁移**——从 ≤0.4.13 直接升级的用户需要重新登录一次（桌面端 App 的登录态仍会被
> 自动复用，不受影响）；旧位置的 `zcode-device-mid` 也会重建为新的设备标识。

**不属于本插件**（只读）：WorkBuddy 桌面端的
`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/*.info`
与 ZCode 桌面端的 `~/.zcode/v2/credentials.json`——这两个文件由各自的桌面
应用管理，插件读取它们以获得登录态，从不写入。

---

## 发布线

稳定线随 monorepo `main` 分支发布；适配 dsh 预发布线的版本在 alpha 分支维护，用 `-alpha.N` / `-rc.N` 后缀发布（prerelease Release）。详见根目录 [RELEASING.md](../../RELEASING.md)。

---

## 免责声明与使用风险

本插件的第三方桌面 Agent 通道依赖各客户端接口，各上游客户端更新后插件可能需要随之调整。

**请在使用前阅读并自行评估以下风险**（本插件为个人开源项目，非任何上游厂商的官方客户端）：

- 本插件通过读取你本机已登录的桌面客户端凭据、复用其登录态来访问模型通道，**不代你注册账号**；
  账号、套餐与配额归各上游厂商，插件不提供任何配额保证。
- 部分通道为了能走通上游网关，会**模拟官方客户端的请求特征**（包括客户端标识/请求头、
  ZCode 的请求签名、以及极少数情况下调整系统提示词以通过指纹校验）。这类做法可能**违反上游
  服务条款**，存在**账号被限流、风控或封禁**的风险；如你介意，请不要使用对应通道。
- 上游随时可能收紧校验或调整接口，相关通道可能**在未通知的情况下失效**；插件无力保证持续可用，
  也不对其他客户端/插件的行为负责。
- 请仅使用**你本人拥有合法使用权的账号**，并遵守各上游的服务条款与当地法律法规。使用本插件
  造成的任何账号、数据或服务损失，由使用者自行承担。
