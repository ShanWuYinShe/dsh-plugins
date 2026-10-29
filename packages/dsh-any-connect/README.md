# @chaoset/dsh-any-connect — DSH 多渠道模型接入插件

将各类桌面 Agent（WorkBuddy 国内版/国际版、ZCode Coding Plan / Start Plan）与官方免费模型通道（OpenCode Free）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用丰富的大模型资源。

> **来源说明**：本包最初源自 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）的独立分支，在 @chaoset 组织下独立演进。命名取 `any-connect`（anyconnect），旨在将更多桌面 Agent 与免费通道模型统一无缝接入 DSH。上游实现的方法论（variant 数据驱动、App 文档 UA 形态、促销生效规则等）经实测验证后移植于此，致以谢意。

---

## 支持通道与功能

- **多通道模型聚合接入**：
  - **WorkBuddy 国内版 (`workbuddy`)**：安装并登录 WorkBuddy 桌面 App 即可零配置使用。全面支持 WorkBuddy 5.6+ 的 `$wbEncrypted` 加密凭据（自动定位 macOS Bundle 或 Windows 注册表/安装目录的 Electron 二进制充当解密助手）。
  - **WorkBuddy AI 国际版 (`workbuddy-ai`)**：独立接入国际版桌面 App，独立提供「WorkBuddy AI」模型分组（GPT、Gemini 系列等）、独立凭据与账号积分卡片。
  - **ZCode Coding Plan (`zcode`)**：接入智谱 ZCode 桌面端 Coding Plan 官方渠道；按桌面端 `setting.json` 当前激活计划精准取用 API Key；以客户端本地内置白名单（`zcode-builtin.json`）动态约束模型（智谱此前的 23:00–09:00 夜间免费限时活动已下线，现按 150% 额度与模型基准计费如实展示）。
  - **ZCode Start Plan (`zcode-start-plan`)**：独立专属通道（`zcode.z.ai/api/v1/zcode-plan/anthropic`）与独立一次性 Token 额度池；采用账号 JWT + 设备标识认证；每日领取活动自动探测并在设置卡片中醒目提醒（提供一键复制 Plan ID）；动态跟随用户今日实际权益展示模型，未领取或过期如实隐藏。
  - **OpenCode Free (`opencode-free`)**：官方免密免费模型通道（Muse Spark 1.2/1.3、Qwen3.6 Plus、MiniMax 系列、Nemotron 3.5 Super VL、DeepSeek V4.1 Flash、Big Pickle 等）；自动过闸标头与 `read` 只读工具守卫注入，解除 "free tier can only be used from within OpenCode" 网关限制；多协议实时流式转码（OpenAI Responses、Anthropic Messages、OpenAI-compatible Chat Completions 统一转为标准 OpenAI SSE 流，完整支持 `reasoning_content` 思考过程输出）；自动读取本地官方 specs 缓存（`~/.cache/opencode/models.json`）决议精确上下文与多模态能力。

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
https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/alpha/market/index.json
```

即可在发现页一键安装本插件、查看与安装任意历史版本（索引与静态 registry 由 CI 从
GitHub Releases 生成，发布在发行分支（当前 `alpha`，收敛后 `main`）根下的 `market/` 目录）。重启 DSH 后更新到指定版本
（DSH 对自建 registry 的自动更新检查只在安装会话内生效）：

```bash
dsh plugin --profile web add @chaoset/dsh-any-connect@<版本> --registry=https://raw.githubusercontent.com/ShanWuYinShe/dsh-plugins/alpha/market/npm/
```

### 方式二：tarball URL（手动）
> 适配的 DSH 版本见本包 `package.json` 的 `engines.dsh` 字段；仓库的 `dsh-v*` git tag 是各次稳定版适配的归档点。

前置条件：若使用桌面 Agent 通道，需在本机安装并登录对应桌面 App（插件自动复用 App 的登录状态，账号切换自动跟随）。使用 OpenCode Free 渠道无需任何前置账号配置。

```bash
# 推荐使用 DSH plugin 命令安装（唯一官方支持的界面为 Web）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/dsh-any-connect-v0.4.27/chaoset-dsh-any-connect-0.4.27.tgz
dsh web

# 从本地源码安装
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/dsh-any-connect

# 卸载
dsh plugin --profile web remove @chaoset/dsh-any-connect
```

`<版本>` 以 [Releases 页](https://github.com/ShanWuYinShe/dsh-plugins/releases)为准。安装后重启 harness 生效。

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

默认操作 WorkBuddy 国内版；使用 `--provider <id>` 切换操作对象（`workbuddy`、`workbuddy-ai`、`zcode`、`zcode-start-plan`、`opencode-free`）：

```bash
dsh-any-connect status --provider workbuddy-ai
dsh-any-connect doctor --provider workbuddy-ai
dsh-any-connect status --provider zcode
dsh-any-connect status --provider zcode-start-plan
dsh-any-connect status --provider opencode-free
```

---

## 配置与系统探测

| 字段 | 默认值 | 说明 |
|---|---|---|
| `authFile` | 自动探测 | 显式指定 WorkBuddy 国内版桌面凭据文件路径（覆盖环境变量与平台默认探测） |
| `authFileAI` | 自动探测 | 同上，作用于 WorkBuddy AI（国际版） |
| `authFileZCode` | 自动探测 | 同上，作用于 ZCode 桌面端凭据文件（覆盖环境变量与平台默认探测） |
| `authFileOpenCode` | 免密公开通道 | 同上，作用于 OpenCode Free 通道的凭据 / token 文件路径（默认免密公开通道，一般无需配置） |

### 凭据来源探测顺序与跨系统支持

- **WorkBuddy**：macOS / Linux 原生路径、Windows 的 Local → Roaming AppData、WSL 下挂载的 Windows 用户目录；亦可用 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE` 环境变量显式指定。
  - **WorkBuddy 5.6+ 的加密凭据**：桌面端自 5.6 起把 `accessToken` / `refreshToken` 以 `$wbEncrypted` 信封加密落盘，解密密钥只存在于其自身的 Electron 进程内。插件自动定位 App 可执行文件充当解密助手：macOS 按 bundle id 检索并校验身份，Windows 探测默认安装目录（`%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`）及卸载注册表。自动定位不成功时，可用 `WORKBUDDY_ELECTRON_BIN`（国内版）或 `WORKBUDDY_AI_ELECTRON_BIN`（国际版）显式指定 App 主程序，**设置后需完全退出并重启 DSH**。
  - **诊断未登录问题**：`dsh-any-connect doctor --json` 会报告 `desktopAuthFile.present`、`desktopAuthFile.format` 与 `atRestHelper`。若格式为 `encrypted` 但助手不可用，按引导设置上述环境变量即可。
- **ZCode**：macOS（`~/.zcode/v2/credentials.json` 及 `Library/Application Support`）、Windows（`%USERPROFILE%\.zcode\v2\credentials.json` 及 Local/Roaming AppData）、WSL（优先通过 WSL 挂载探测 Windows 宿主用户目录与 AppData，并自动计算跨系统解密密钥，随后回落 Linux 原生目录）、Linux（`~/.zcode/v2/credentials.json` 及 `~/.config`）；亦可用 `ZCODE_AUTH_FILE` 环境变量显式指定。
  - **Coding Plan 与 Start Plan 是两个独立连接**：`zcode` 与 `zcode-start-plan` 各自拥有独立的模型分组、模型名单、额度池与请求通道；
  - **Coding Plan 白名单**：以本机 ZCode 客户端内置目录（`zcode-builtin.json` 的 `builtinModelIds`）为白名单，随客户端发版自动更新（当前为 GLM-5.3、GLM-5.3-Flash）；可用 `ZCODE_BUILTIN_CONFIG` 显式指定该文件路径；
  - **Start Plan 专属通道与每日领取**：走 `zcode.z.ai/api/v1/zcode-plan/anthropic`，扣减一次性 token 包；每日领取需通过客户端完成，插件每天自动探测可领活动并在卡片醒目提示；
  - **夜间免费限时活动已下线**：智谱此前的 23:00–09:00 夜间免费窗（曾为 Coding Plan 专属权益，Start Plan 不享受）已下线，插件已移除夜免徽标与费率改写，模型按 150% 额度与基准计费如实展示。
- **OpenCode Free**：免密直连。支持通过 `OPENCODE_MODELS_CACHE` 环境变量显式指定官方 models specs 缓存文件路径（默认为 `~/.cache/opencode/models.json`）。

### 上游限流（429）的记录与展示

模型通道被上游限流时，插件把观测**落到进程内台账**（`rate-limit.ts`），并在
两处如实展示：配置页卡片（「上游限流中」提示框）与 composer 的额度 pill。

**台账只观测、不拦截**：它不参与任何请求门禁，也不会因为「上次被限」而拒绝
后续请求。请求是否放行完全由上游决定——插件的职责只是把上游说过的话显示出来，
不是替上游做决定。成功请求会自动清除台账（解除由上游事实驱动，不靠推算）。

口径只有一条：**恢复时刻只来自上游响应头**。

- `Retry-After`（相对秒 / HTTP-date）与 `X-RateLimit-Reset`（秒或毫秒 epoch）
  能解析出恢复时刻 → 显示「{时间} 恢复」；
- 上游没给 → 显示「已被限 {时长}，上游未提供恢复时间」，并给出被拒次数与模型名。
  **绝不按固定窗口推算倒计时**。

各上游的公开口径（2026-10-29 核对官方文档）：

| 上游 | 限流维度 | 是否给恢复时刻 |
| --- | --- | --- |
| GLM Coding Plan（`zcode`） | 按订阅档位的**并发数**，平台动态调整；另有每 5 小时 / 每周**积分**额度 | 并发限流**不给**；积分额度走额度通道，由窗口自带的 `resetsAt` 表达（5 小时积分按消耗时刻滚动刷新） |
| ZCode Start Plan | 一次性 token 池（按模型分池） | 池子的 `expiredAt` 走额度窗口 |
| OpenCode Free | 官方免费通道频次/并发风控（`FreeTierError`，HTTP 403） | 不给 |
| WorkBuddy | 计费包积分制，无公开限流文档 | 不给 |

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

## 免责声明

本插件的第三方桌面 Agent 通道依赖各客户端接口，各上游客户端更新后插件可能需要随之调整。
