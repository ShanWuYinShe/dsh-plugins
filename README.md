# dsh-plugins — DSH host 层插件集

DSH（DeepSeek Harness）host 层全局插件的 monorepo：

| 包 | 功能 |
|---|---|
| [`@chaoset/sandbox-extra-roots`](packages/sandbox-extra-roots/) | 沙盒额外允许写入目录（Seatbelt/bwrap/Landlock + fs fence） |
| [`@chaoset/session-archive`](packages/session-archive/) | 归档会话管理：浏览、批量恢复或彻底删除归档会话 |
| [`@chaoset/dsh-any-connect`](packages/dsh-any-connect/) | 接入 WorkBuddy 桌面 App 的模型到 DSH（零配置 + 思考强度/费率显示；源自 corrinehu/dsh-workbuddy-connect 的独立分支） |
| [`@chaoset/provider-usage`](packages/provider-usage/) | 对话区底栏显示当前 provider 的剩余额度；通用查询器注册机制，任何 provider 插件都能接入 |

每个包都提供：

- **host 插件**（`src/` 编译为 `lib/`，纯 ESM，随 harness 加载）
- **client 插件**（`client/index.tsx` 预打包为 `client/client.cjs`，宿主直接加载）——
  配置类插件在设置页「插件配置」提供配置卡片；`session-archive` 在侧边栏提供归档面板
- **远程服务**：配置经 `ctx.remote.<svc>` 读写，持久化到 `~/.dsh/plugins/<name>/config.json`，
  保存后热生效；`session-archive` 提供 `ctx.remote.sessionArchive`（列表/详情/删除/恢复）
- **bundle patch**：自带 `cordis.patch.yml`，`dsh plugin` 安装后自动成为 profile bundle 层

## 安装

推荐用 DSH 自带的 `dsh plugin`：它会调用 pnpm 安装依赖，并把声明了 `dsh.bundle`
的包加入 `dsh.profile.bundles`，随后 DSH 应用包内 `cordis.patch.yml` 完成插件注册。

本仓库通过 **GitHub Releases 分发**：CI 随每次发布把每个包打包成标准 npm
tarball，挂在对应 Release（tag 名 `<目录>-v<版本>`）的资产里；`dsh plugin add`
直接装 tarball URL，公开仓库无需任何认证：

```bash
# 安装（<版本> 以 Releases 页最新为准：https://github.com/ShanWuYinShe/dsh-plugins/releases，
# 资产名 = 包名去 @ 换 -，即 chaoset-<目录>-<版本>.tgz）
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/provider-usage-v<版本>/chaoset-provider-usage-<版本>.tgz
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/session-archive-v<版本>/chaoset-session-archive-<版本>.tgz

# 例如 provider-usage@0.1.0-alpha.0：
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/provider-usage-v0.1.0-alpha.0/chaoset-provider-usage-0.1.0-alpha.0.tgz

# 预发布线 Release 带 prerelease 标记（版本号带 -alpha / -rc 后缀），
# 适配 dsh 预发布版本；无后缀的正式 Release 适配 dsh 稳定线。

# 从本地源码安装（换成本仓库 monorepo 子包的绝对路径，符号链接即装）
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/session-archive

# 卸载
dsh plugin --profile web remove @chaoset/provider-usage
dsh plugin --profile web remove @chaoset/session-archive
```

查各包已发布版本：`gh release list --repo ShanWuYinShe/dsh-plugins` 或直接看
Releases 页；某个包版本适配哪个 dsh 见该 Release 说明或包 `dsh.host` 字段。

安装后**重启 harness** 生效（或等待 DSH 对配置层变更的响应）。

### 历史说明：npm

本仓库的包早期（2026-09 前）曾发布到 npm（`@chaoset/*`），那些版本已全部标记
废弃并停止更新；npm 上的旧版本不再维护，请一律按上面的 GitHub Release 方式安装。

### 安装排障（已知坑）

- **pnpm 供应链策略拦下安装**：pnpm v11 默认拦截依赖的构建脚本并启用
  发布满 24 小时才可安装的策略。`dsh plugin add` 首次执行可能报
  `pnpm failed`——到 profile 目录（`$DSH_HOME/profiles/<name>`）的
  `pnpm-workspace.yaml` 里把 `allowBuilds` 占位的 `set this to true or
  false` 改为 `true`，刚发布的 `@chaoset/*@<版本>` 加进
  `minimumReleaseAgeExclude`，然后**重跑一次 `dsh plugin add`**（首次失败
  时 bundle 对账未完成，插件不会真正注册）。

> 不要只把包名写进 profile 的 `package.json`（或直接跑 `pnpm add`）：那只会安装
> 依赖，不会做 bundle 对账、不会注册 bundle 层，web boot 会报
> `pending (waiting for service: remote.xxxConfig)`。

### 给 AI agent

这些包常由 DSH agent 代为安装。直接执行 `dsh plugin ...` 命令即可，**不要手动
编辑 `cordis.patch.yml`**：

1. 确认 `dsh` 在 PATH 中、`pnpm` 可用（缺失时 `npm install -g pnpm` 或
   `corepack enable pnpm`）。
2. 确定目标 profile（默认 `web`，也可能是 `tui` / `headless` / 自定义；
   `dsh --profile web --help` 可验证）。
3. 按上面的命令安装（版本号从 Releases 页获取）；开发验证时用本地路径。
4. 验证：`dsh plugin --profile web list`，或
   `dsh --profile web --dump-config | grep chaoset`。
5. 重启 DSH。

### 从 DSH 源码运行 DSH 时

DSH 从源码仓库运行（不全局安装 `dsh` 与 `@deepseek-ai/*`）时，插件无需任何额外
配置：harness 启动时会把依赖闭包 symlink 镜像到 `$DSH_HOME/profiles/node_modules`，
插件加载 `@deepseek-ai/*` 官方包时优先从这里以 realpath 导入（与 harness 同一
模块实例），失败才回落插件自身依赖树。安装命令与上面相同，包名换成本地路径。

## 开发

`@deepseek-ai/*` 内部包来自公共 registry，作为根部 `devDependencies` 由 pnpm 安装
（workspace 声明在 `pnpm-workspace.yaml`，pnpm 版本由根 `package.json` 的
`packageManager` 字段锁定，Corepack 会自动匹配）：

```bash
pnpm install       # 安装依赖
pnpm run build     # 全仓构建：每包 tsc 编译 src/ → lib/，esbuild 打包 client
pnpm run typecheck # tsc --noEmit（host + client 两套 tsconfig）
pnpm run test      # vitest 回归（host 插件 / config-store / 上游客户端等）
pnpm run test:ci   # build + typecheck + test（发布前验证）
```

## 版本管理与发布

- **想知道某个包版本适配哪个 dsh**：看对应 Release 的说明，或该包 tarball 内
  `package.json` 的 `dsh.host` 字段。
- 发布线：正式 Release（无后缀版本号）适配 dsh 稳定线；prerelease Release
  （`-alpha.N` / `-rc.N`）适配 dsh 预发布线。
- 分支模型、版本号规则、宿主升级适配与发布流程的完整约定见
  [RELEASING.md](RELEASING.md)。
