# @chaoset/dsh-any-connect — DSH 模型接入插件（WorkBuddy 桌面 Agent）

将 WorkBuddy 桌面 App 中包含的各种模型（GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、
DeepSeek-V4.1-Flash、Kimi-K3、MiniMax-M3、Hy3 等，国际版另有 GPT/Gemini
系列）自动接入 DeepSeek Harness，
实现在 DSH 对话窗口里零配置使用。

> **来源说明**：本包是 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)
> （MIT）的独立分支，在 @chaoset 组织下独立演进，命名取 `any-connect`
> （anyconnect）是因为后续可能接入其他类似 WorkBuddy 的桌面 Agent（它们
> 提供的模型都能经此接入 DSH）。上游实现的方法论（variant 数据驱动、
> App 文档 UA 形态、促销生效规则等）经实测验证后移植于此，致以谢意。

## 功能

- **开箱即用**：安装并登录 WorkBuddy 桌面 App 后即可在 DSH 中使用，零配置。

- **图片输入**：按上游逐模型声明的能力放行图片——绝大多数模型（含
  GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）可直接粘贴或拖入图片；个别纯
  文本模型（如 GLM-5.1）按上游声明仍会明确提示不支持。

- **思考强度**：按上游每个模型声明的 `supportedEfforts` 提供思考等级选项
  （如 GLM-5.3 支持 low / high / max，未声明档位的模型如 GLM-5.2 默认只有
  单档），在 DSH 模型选择器里即可切换，请求以 `reasoning_effort` 转发。未声明
  档位的模型可在配置卡片里手动检测（逐行确认，会发少量真实请求）：测出上游真
  校验的档位即进入选择器，测出"不校验"的模型不再误给档位。

- **限时免费一目了然**：状态卡片会标注当前免费 / 限时免费 / 夜间折扣的模型
  （跟随上游 `credits` 与 `tags` 实时更新）。

- **费率比例直接可见**：模型选择列表里每个模型名后直接显示积分倍率（如
  `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与 composer 下拉都能看到；
  设置卡片里也补充了倍率说明。倍率只影响显示，发送请求仍使用模型 id。

- **信息查看**：侧栏 → Plugins → 打开本插件的卡片，展开后可查看账号信息、
  令牌有效期、剩余积分、模型优惠、模型列表来源与上下文窗口（含可选的更大
  窗口）。

- **国际版（WorkBuddy AI）**：装了国际版 App 会多出独立的「WorkBuddy AI」
  模型分组、账号、积分与配置卡片，与国内版互不混用；只装一版就只出现
  一版。从未登录的一版不显示分组（而不是展示点选必错的名单）。

- **ZCode（GLM Coding Plan）**：配置一个智谱 bigmodel 控制台创建的 API key
  （与 coding plan 同账号），即可把 coding plan 的 GLM 模型接入 DSH。key
  消耗的正是 zcode CLI 使用的同一份套餐额度。获取方式与如实限制见下方
  「ZCode（GLM Coding Plan）接入」一节。

## 安装

> 适配的 DSH 版本见本包 `package.json` 的 `dsh.host` 字段；仓库的 `dsh-v*`
> git tag 是各次稳定版适配的归档点。

前置：已安装并登录 WorkBuddy 桌面 App（插件复用 App 的登录状态，账号切换自动
跟随）。

```bash
# Web（唯一支持的界面）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/dsh-any-connect-v<版本>/chaoset-dsh-any-connect-<版本>.tgz
dsh web

# 从本地源码安装
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/dsh-any-connect

# 卸载
dsh plugin --profile web remove @chaoset/dsh-any-connect
```

`<版本>` 以 [Releases 页](https://github.com/ShanWuYinShe/dsh-plugins/releases)为准。

> 本包目前只支持 Web 界面，其他界面（Desktop / TUI / headless）暂不
> 考虑、不承诺可用。

> 给 AI agent：直接执行 `dsh plugin ...` 命令即可，不要手动编辑
> `cordis.patch.yml`。

## CLI

包附带 `dsh-any-connect` 命令，用于排查登录与宿主健康：

```bash
dsh-any-connect doctor     # 全面体检（凭据、令牌、宿主心跳、模型目录）
dsh-any-connect status     # 当前登录态与积分
dsh-any-connect logout     # 移除本插件的凭据副本（不动桌面 App 的登录）
```

默认操作国内版；加 `--provider workbuddy-ai` 操作国际版，`--provider zcode`
操作 ZCode（GLM Coding Plan）：

```bash
dsh-any-connect status --provider workbuddy-ai
dsh-any-connect doctor --provider workbuddy-ai
dsh-any-connect doctor --provider zcode   # 含一次真实 key 校验（≤32 token）
dsh-any-connect status --provider zcode
```

## ZCode（GLM Coding Plan）接入

zcode 桌面端（ZCode.app）的 OAuth 凭据是应用级加密存储，插件无法复用；
本 provider 走「用户自建 API key」路线：

1. 在 [bigmodel 控制台](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)
   （用户中心 → API Keys）创建一个 API key，账号须与你的 coding plan 一致；
2. 三选一配置（优先级从高到低）：插件设置卡的 `apiKeyZcode` 字段 →
   `ZCODE_API_KEY` 环境变量 → `~/.dsh/.zcode-auth.json`
   （内容 `{"version":1,"apiKey":"..."}`）；
3. 模型分组即出现在 DSH 模型选择器（GLM-5.3 / GLM-5.3-Flash / GLM-5.2 /
   GLM-5-Turbo），对话经本机 loopback shim 以 Anthropic Messages 协议直通
   `open.bigmodel.cn`。

如实说明：

- **额度**：coding plan 的 key 调用即按套餐结算，与 zcode CLI 共享同一份
  额度（含加量促销，以智谱服务端实际结算为准）。
- **夜间免费（off-peak）不可用**：zcode 的免费时段依赖其客户端持有的服务端
  票据（`x-off-peak-ticket-id`），第三方直连拿不到；能否享受优惠以智谱按时段
  的计费策略为准，插件不承诺。
- **额度余量不显示**：查询余额的管理面有签名 + PoW 防护，插件不复刻；卡片只
  展示 key 来源与掩码。
- 上游为智谱非官方承诺的第三方接入面，调整可能需要跟随。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `authFile` | 自动探测 | 显式指定 WorkBuddy 桌面凭据文件路径（覆盖环境变量与平台默认探测） |
| `authFileAI` | 自动探测 | 同上，作用于 WorkBuddy AI（国际版） |
| `apiKeyZcode` | 空 | GLM Coding Plan API key（bigmodel 控制台创建；空值回落 `ZCODE_API_KEY` env 与 `~/.dsh/.zcode-auth.json`） |
| `probeConsent` | false | 授权推理档位检测（检测会发送真实请求，可能消耗积分） |

生效顺序（后者覆盖前者）：内置默认值 → bundle patch 的 config →
profile/home 的 `cordis.patch.yml` → 设置页。凭据来源的探测顺序与上游一致：
macOS/Linux 的原生路径、Windows 的 Local → Roaming AppData、WSL 下挂载的
Windows 用户目录；也可用 `WORKBUDDY_AUTH_FILE` 环境变量直接指定。

## 发布线

稳定线随 monorepo `main` 分支发布；适配 dsh 预发布线的版本在 alpha 分支
维护，用 `-alpha.N` / `-rc.N` 后缀 + 对应 dist-tag 发布。本包实际适配的
宿主版本看 `npm view @chaoset/dsh-any-connect dsh.host`。与 dsh 版本无关
的改动会同步到两条线。

## 与上游的差异

- 包名/标识改为 `@chaoset/dsh-any-connect`（插件名 `llm-anyconnect`、设置命名
  空间 `anyconnect`），provider 路由仍叫 `workbuddy`（接入的 Agent 名，非包标识）。
- 版本改为运行时读 `package.json`（monorepo 无 tsdown `define`），杜绝发布产物
  报旧版本号的漂移。
- 上游 v0.3.0-alpha.0 的费率显示、思考强度、`developer`→`system` 改写、
  15 模型兜底目录均已并入。

## 免责声明

依赖 WorkBuddy 客户端接口（非官方公开 API），WorkBuddy 更新后插件可能需要随之
调整。
