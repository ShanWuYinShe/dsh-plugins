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
  （如 GLM-5.3 支持 low / high / xhigh，GLM-5.3-Flash 支持 low / high / max），
  在 DSH 模型选择器里即可切换，请求以 `reasoning_effort` 转发。未声明档位
  的模型可在配置卡片里手动检测（逐行确认，会发少量真实请求）：测出上游真
  校验的档位即进入选择器，测出"不校验"的模型不再误给档位。

- **限时免费一目了然**：状态卡片会标注当前免费 / 限时免费 / 夜间折扣的模型
  （跟随上游 `credits` 与 `tags` 实时更新）。

- **费率比例直接可见**：模型选择列表里每个模型名后直接显示积分倍率（如
  `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与 composer 下拉都能看到；
  设置卡片里也补充了倍率说明。倍率只影响显示，发送请求仍使用模型 id。

- **信息查看**：设置 → 插件 → 配置卡片，展开后可查看账号信息、令牌有效期、
  剩余积分、模型优惠、模型列表来源与上下文窗口（含可选的更大窗口）。

- **国际版（WorkBuddy AI）**：装了国际版 App 会多出独立的「WorkBuddy AI」
  模型分组、账号、积分与配置卡片，与国内版互不混用；只装一版就只出现
  一版。从未登录的一版不显示分组（而不是展示点选必错的名单）。

## 安装

> 适配的 DSH 版本见本包 `package.json` 的 `dsh.host` 字段
> （`npm view <包名> dsh.host` 可查）；仓库的 `dsh-v*` git tag 是各次
> 稳定版适配的归档点。

前置：已安装并登录 WorkBuddy 桌面 App（插件复用 App 的登录状态，账号切换自动
跟随）。

```bash
# Web（唯一支持的界面）
dsh plugin --profile web add @chaoset/dsh-any-connect
dsh web

# 从本地源码安装
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/dsh-any-connect

# 卸载
dsh plugin --profile web remove @chaoset/dsh-any-connect
```

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

默认操作国内版；加 `--provider workbuddy-ai` 操作国际版：

```bash
dsh-any-connect status --provider workbuddy-ai
dsh-any-connect doctor --provider workbuddy-ai
```

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `authFile` | 自动探测 | 显式指定 WorkBuddy 桌面凭据文件路径（覆盖环境变量与平台默认探测） |

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
