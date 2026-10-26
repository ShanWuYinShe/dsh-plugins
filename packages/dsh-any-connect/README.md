# @chaoset/dsh-any-connect — DSH 多渠道模型接入插件

将各类桌面 Agent（WorkBuddy 国内版/国际版、ZCode Coding Plan / Start Plan）与官方免费模型通道（OpenCode Free）自动接入 DeepSeek Harness，实现在 DSH 对话窗口里零配置使用丰富的大模型资源。

> **来源说明**：本包最初源自 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）的独立分支，在 @chaoset 组织下独立演进。命名取 `any-connect`（anyconnect），旨在将更多桌面 Agent 与免费通道模型统一无缝接入 DSH。上游实现的方法论（variant 数据驱动、App 文档 UA 形态、促销生效规则等）经实测验证后移植于此，致以谢意。

---

## 支持通道与功能

- **多通道模型聚合接入**：
  - **WorkBuddy 国内版 (`workbuddy`)**：安装并登录 WorkBuddy 桌面 App 即可零配置使用。全面支持 WorkBuddy 5.6+ 的 `$wbEncrypted` 加密凭据（自动定位 macOS Bundle 或 Windows 注册表/安装目录的 Electron 二进制充当解密助手）。
  - **WorkBuddy AI 国际版 (`workbuddy-ai`)**：独立接入国际版桌面 App，独立提供「WorkBuddy AI」模型分组（GPT、Gemini 系列等）、独立凭据与账号积分卡片。
  - **ZCode Coding Plan (`zcode`)**：接入智谱 ZCode 桌面端 Coding Plan 官方渠道；按桌面端 `setting.json` 当前激活计划精准取用 API Key；以客户端本地内置白名单（`zcode-builtin.json`）动态约束模型；支持 23:00–09:00 夜间免费时段自动识别与费率联动。
  - **ZCode Start Plan (`zcode-start-plan`)**：独立专属通道（`zcode.z.ai/api/v1/zcode-plan/anthropic`）与独立一次性 Token 额度池；采用账号 JWT + 设备标识认证；每日领取活动自动探测并在设置卡片中醒目提醒（提供一键复制 Plan ID）；动态跟随用户今日实际权益展示模型，未领取或过期如实隐藏。
  - **OpenCode Free (`opencode-free`)**：官方免密免费模型通道（Muse Spark 1.2/1.3、Qwen3.6 Plus、MiniMax 系列、Nemotron 3.5 Super VL、DeepSeek V4.1 Flash、Big Pickle 等）；自动过闸标头与 `read` 只读工具守卫注入，解除 "free tier can only be used from within OpenCode" 网关限制；多协议实时流式转码（OpenAI Responses、Anthropic Messages、OpenAI-compatible Chat Completions 统一转为标准 OpenAI SSE 流，完整支持 `reasoning_content` 思考过程输出）；自动读取本地官方 specs 缓存（`~/.cache/opencode/models.json`）决议精确上下文与多模态能力。

- **图片输入（多模态）**：
  - 按上游逐模型声明的能力放行图片——绝大多数多模态模型（含 GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）可直接在对话框粘贴或拖入图片；纯文本模型按上游声明如实提示不支持。

- **思考强度智能适配**：
  - 按上游每个模型声明的 `supportedEfforts` 提供思考等级选项（如 GLM-5.3 支持 low / high / max），在 DSH 模型选择器里即可切换，请求以 `reasoning_effort` 转发；
  - 后台全自动检测与补测未声明档位的模型（每模型仅少量真实请求），测出真实校验档位即进入选择器；
  - 选择器的「默认」档对**只能在思考态工作**的模型（上游 `onlyReasoning`）智能补具体档位（优先 `high`，无则取最高档）；OpenAI 通道补顶层 `reasoning_effort`，Anthropic 通道补 `thinking` 预算对象（`enabled` + `budget_tokens` 并相应抬高 `max_tokens`）。

- **费率比例与限免标注**：
  - 模型选择列表（`/model` 弹窗与 composer 下拉）中每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`）；
  - 状态卡片实时跟随上游标记当前免费 / 限时免费 / 夜间折扣模型。

- **今日积分消耗统计（WorkBuddy）**：
  - WorkBuddy 的积分是「裂变包」制（上游每天发一个新包、旧包到期整包消失），「当前积分」每天双向跳动，单看一个时刻读不出今天花了多少；
  - 插件对每次成功查询积分做采样差分记账（今日已用 / 今日发放 / 今日峰值），在额度 pill（展开后「今日已用」行）、配置页卡片（今日统计 + 近 7 日每日消耗）与 `status` CLI 三处展示；
  - 口径为**估算**：只有 DSH 运行且轮询到查询时才有样本，两次采样之间「发放+消耗」抵消的量会被低估；跨天首观测不计差分（无法归属到哪一天，宁少不虚记）。今日峰值即稳定的「今天的总额度基准」（今日已用 ≈ 峰值 − 当前剩余）。

- **自定义模型管理**：
  - 设置页模型列表中支持点击删除图标**自定义隐藏/排除不常用模型**；
  - 卡头清晰展示排除模型计数，并提供一键「恢复默认」入口；
  - 模型清单可随时折叠/展开，清晰列出倍率、最大/备选上下文窗口、思考档位与特性标签。

---

## 安装

> 适配的 DSH 版本见本包 `package.json` 的 `dsh.host` 字段；仓库的 `dsh-v*` git tag 是各次稳定版适配的归档点。

前置条件：若使用桌面 Agent 通道，需在本机安装并登录对应桌面 App（插件自动复用 App 的登录状态，账号切换自动跟随）。使用 OpenCode Free 渠道无需任何前置账号配置。

```bash
# 推荐使用 DSH plugin 命令安装（唯一官方支持的界面为 Web）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/dsh-any-connect-v0.4.19/chaoset-dsh-any-connect-0.4.19.tgz
dsh web

# 从本地源码安装
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/dsh-any-connect

# 卸载
dsh plugin --profile web remove @chaoset/dsh-any-connect
```

`<版本>` 以 [Releases 页](https://github.com/ShanWuYinShe/dsh-plugins/releases)为准。安装后重启 harness 生效。

> 给 AI agent：直接执行 `dsh plugin ...` 命令即可，不要手动编辑 `cordis.patch.yml`。

---

## CLI 诊断工具

包附带 `dsh-any-connect` 命令，用于快速排查各渠道登录态与宿主健康：

```bash
dsh-any-connect doctor     # 全面体检（凭据、登录态、加密助手、宿主心跳、内置兜底名单数量）
dsh-any-connect status     # 当前登录态与积分/额度
dsh-any-connect logout     # 移除本插件的凭据副本（不动桌面 App 的登录）
```

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

### 凭据来源探测顺序与跨系统支持

- **WorkBuddy**：macOS / Linux 原生路径、Windows 的 Local → Roaming AppData、WSL 下挂载的 Windows 用户目录；亦可用 `WORKBUDDY_AUTH_FILE` / `WORKBUDDY_AI_AUTH_FILE` 环境变量显式指定。
  - **WorkBuddy 5.6+ 的加密凭据**：桌面端自 5.6 起把 `accessToken` / `refreshToken` 以 `$wbEncrypted` 信封加密落盘，解密密钥只存在于其自身的 Electron 进程内。插件自动定位 App 可执行文件充当解密助手：macOS 按 bundle id 检索并校验身份，Windows 探测默认安装目录（`%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`）及卸载注册表。自动定位不成功时，可用 `WORKBUDDY_ELECTRON_BIN`（国内版）或 `WORKBUDDY_AI_ELECTRON_BIN`（国际版）显式指定 App 主程序，**设置后需完全退出并重启 DSH**。
  - **诊断未登录问题**：`dsh-any-connect doctor --json` 会报告 `desktopAuthFile.present`、`desktopAuthFile.format` 与 `atRestHelper`。若格式为 `encrypted` 但助手不可用，按引导设置上述环境变量即可。
- **ZCode**：macOS（`~/.zcode/v2/credentials.json` 及 `Library/Application Support`）、Windows（`%USERPROFILE%\.zcode\v2\credentials.json` 及 Local/Roaming AppData）、WSL（优先通过 WSL 挂载探测 Windows 宿主用户目录与 AppData，并自动计算跨系统解密密钥，随后回落 Linux 原生目录）、Linux（`~/.zcode/v2/credentials.json` 及 `~/.config`）；亦可用 `ZCODE_AUTH_FILE` 环境变量显式指定。
  - **Coding Plan 与 Start Plan 是两个独立连接**：`zcode` 与 `zcode-start-plan` 各自拥有独立的模型分组、模型名单、额度池与请求通道；
  - **Coding Plan 白名单**：以本机 ZCode 客户端内置目录（`zcode-builtin.json` 的 `builtinModelIds`）为白名单，随客户端发版自动更新（当前为 GLM-5.3、GLM-5.3-Flash）；可用 `ZCODE_BUILTIN_CONFIG` 显式指定该文件路径；
  - **Start Plan 专属通道与每日领取**：走 `zcode.z.ai/api/v1/zcode-plan/anthropic`，扣减一次性 token 包；每日领取需通过客户端完成，插件每天自动探测可领活动并在卡片醒目提示；
  - **夜间免费专属 Coding Plan**：23:00–09:00 免费窗仅属于 Coding Plan，Start Plan 不享受夜免。
- **OpenCode Free**：免密直连。支持通过 `OPENCODE_MODELS_CACHE` 环境变量显式指定官方 models specs 缓存文件路径（默认为 `~/.cache/opencode/models.json`）。

---

## 数据与文件位置

插件在 DSH home（默认 `~/.dsh`，可被 `$DSH_HOME` 覆盖）内维护三处数据，不再向 home 根目录平铺散文件：

| 位置 | 内容 | 说明 |
|---|---|---|
| `storages/dsh_any_connect/auth/` | 各变体的自有凭据副本（每变体一个 JSON） | 宿主存储域（storageDomain）：schema 校验、原子写、损坏记录自动备份。桌面端凭据可读时通常为空。 |
| `.dsh-any-connect/` | `zcode-device-mid` 设备标识；存储域不可用时的凭据副本文件回落 | 正常情况只有设备标识一个文件。 |
| `cache/dsh-any-connect/` | 模型目录 ×5、档位探测结果、桌面版本记录、host 心跳 | 可再生缓存，删除后自动重建。 |

旧版平铺在 home 根目录的散文件（`.workbuddy-auth.json` 等）在启动时自动迁移进上述位置。

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
