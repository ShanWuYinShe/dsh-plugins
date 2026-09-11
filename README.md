# dsh-plugins — DSH host 层插件集

DSH（DeepSeek Harness）host 层全局插件的 monorepo：

| 包 | 功能 |
|---|---|
| [`@chaoset/sandbox-extra-roots`](packages/sandbox-extra-roots/) | 沙盒额外允许写入目录（Seatbelt/bwrap/Landlock + fs fence） |
| [`@chaoset/session-archive`](packages/session-archive/) | 归档会话管理：浏览、批量恢复或彻底删除归档会话 |
| [`@chaoset/dsh-any-connect`](packages/dsh-any-connect/) | 接入 WorkBuddy 桌面 App 的模型到 DSH（零配置 + 思考强度/费率显示；源自 corrinehu/dsh-workbuddy-connect 的独立分支） |

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

```bash
# 从 npm 安装（三个包一起，正式线 = latest dist-tag）
dsh plugin --profile web add @chaoset/sandbox-extra-roots
dsh plugin --profile web add @chaoset/session-archive
dsh plugin --profile web add @chaoset/dsh-any-connect

# 预发布线（适配 dsh 预发布版本，发布在对应 dist-tag，npm tag 语法）
dsh plugin --profile web add @chaoset/sandbox-extra-roots@alpha

# 从本地源码安装（包名换成 monorepo 子包的绝对路径）
dsh plugin --profile web add /absolute/path/to/dsh-plugins/packages/session-archive

# 卸载
dsh plugin --profile web remove @chaoset/sandbox-extra-roots
dsh plugin --profile web remove @chaoset/session-archive
dsh plugin --profile web remove @chaoset/dsh-any-connect
```

其他来源：

- **GitHub**：`dsh plugin --profile web add github:owner/repo` 或 Release tarball 的
  URL（Release 由 CI 随每次发布按 `<目录>-v<版本>` 自动创建）。本仓库是
  monorepo，子包没有独立仓库，请优先用 npm 包名或本地路径安装。
- **镜像站**：`dsh plugin --profile web add @chaoset/session-archive --registry=https://registry.npmmirror.com`（或设置 `npm_config_registry`）。

安装后**重启 harness** 生效（或等待 DSH 对配置层变更的响应）。

### 安装排障（两个已知坑）

- **刚发布的版本装不上 / 装到旧版**：若环境配置了镜像源（如
  `registry.npmmirror.com`），新发布的版本可能尚未同步；显式指定官方源
  安装：`dsh plugin --profile web add @chaoset/dsh-any-connect --registry=https://registry.npmjs.org`。
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
3. 按上面的命令安装；包未发布时用本地路径。
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
pnpm run test      # vitest 回归（host 插件 / config-store / 自适应引擎等）
pnpm run test:ci   # build + typecheck + test（发布前验证）
```

## 版本管理与发布

- **想知道某个包版本适配哪个 dsh**：`npm view @chaoset/<包名>@<版本> dsh.host`，
  或看该包 README 安装节。
- 发布线：npm `latest` 适配 dsh 稳定线，`@alpha` / `@rc` dist-tag 适配 dsh
  预发布线（版本后缀自动决定 dist-tag）。
- 分支模型、版本号规则、宿主升级适配与发布流程的完整约定见
  [RELEASING.md](RELEASING.md)。
