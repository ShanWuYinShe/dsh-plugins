# @chaoset/sandbox-extra-roots — DSH 沙盒额外允许目录插件

给 dsh 沙盒的 `workspace-write` 模式增加「额外允许写入的目录」列表（工具缓存
目录等），**官方白名单始终保留**（workspace 根 + /tmp + 平台临时目录），只追加不替换。

本插件现在只做**设置页 UX + 校验**，强制力完全交给宿主官方能力：把配置根并入
`sandbox-policy` 的 `SandboxExecutionPolicy.additionalWritableRoots`，由官方
Seatbelt / bwrap / Landlock / 文件系统围栏从同一来源消费（与官方 headless
`--add-dir` 同字段）。不再包装 `ctx.fs.checkedTarget`、不再重建 SBPL profile、不再
拼接 bwrap/Landlock argv。

> 只想改配置、不需要 GUI 的用户：官方支持直接写 profile `cordis.patch.yml` 的
> `sandbox-policy` 行（`config.additionalWritableRoots`），不需要安装本插件；
> 官方目前**没有**该字段的图形设置页。本插件提供的价值是设置卡片、危险根/相对路径
> 校验、常用缓存预设、缺失目录过滤与「额外根未生效」的可见降级提示。

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
dsh plugin --profile web add @chaoset/sandbox-extra-roots@<版本>
dsh plugin --profile web remove @chaoset/sandbox-extra-roots
```

### 方式二：tarball URL（手动）
> 适配的 DSH 版本见本包 `package.json` 的 `engines.dsh` 字段（官方兼容声明）；
> 宿主 0.2.2 起要求 **Node.js >= 24.9**（`engines.node` 同步声明）。
> 仓库的 `dsh-v*` git tag 是各次稳定版适配的归档点。

本包是 DSH bundle：自带 `cordis.patch.yml`，`dsh plugin` 安装后自动加入
profile 的 `dsh.profile.bundles`，无需手改 `cordis.patch.yml`。

```bash
dsh plugin --profile web add https://github.com/ShanWuYinShe/dsh-plugins/releases/download/sandbox-extra-roots-v<版本>/chaoset-sandbox-extra-roots-<版本>.tgz
dsh plugin --profile web remove @chaoset/sandbox-extra-roots
```

`<版本>` 以 [Releases 页](https://github.com/ShanWuYinShe/dsh-plugins/releases)为准
（该包最新 Release 的资产即本包最新发布产物）。也支持本地路径安装，见仓库根
`README.md` 的「安装」。安装后重启 harness 生效。

> 给 AI agent：直接执行 `dsh plugin ...` 命令即可，不要手动编辑 `cordis.patch.yml`。

## 配置

生效顺序（后者覆盖前者）：

1. 插件内置默认（空列表）
2. bundle patch 中 `cordis.patch.yml` 的 config
3. 用户 profile/home 的 `cordis.patch.yml` 覆盖
4. **DSH 设置页 → 插件配置 → 沙盒额外允许目录**（经官方 config-editor
   保存到当前 profile 的 `cordis.patch.yml` 本行 config，立即热生效；
   配置只走官方通道，旧版自建 `config.json` 迁移已删除）

`extraWritableRoots`：绝对路径数组（设置页里每行一个，支持 `~` 表示用户主目录；
`Config` 为官方 Schemastery schema，默认 `[]`，patch 里写非法形状会被拒绝并告警）。
相对路径/空值会被拒绝并告警；危险根（`/`、盘根、主目录本身及其父目录，如
macOS 的 `/Users`）保存时直接拒绝，系统目录（`/etc` `/usr` `/bin` `/sbin` 及
macOS 的 `/private`，仅 POSIX——Windows 暂无对应条目）被过滤，重复行自动去重。
设置页卡片在保存前就地预览这些问题行（危险/无效行会禁用保存按钮；系统目录
行保存成功但不生效）。常用工具缓存（npm/bun/pip/cargo/go）可一键添加进列表，
点选即视为用户显式确认；含明文凭证的目录不在预设内。运行期两件事：

1. **身份校验**（插件侧，纵深防御）：配置期已按 realpath 规范化，每次解析策略时若
   `canon(目录)` 与配置的物理路径不再一致（目录或路径组件被替换成符号链接），该根
   **直接剔除并告警**，绝不跟随重定向；
2. **缺失目录过滤**：不存在或不是目录的根不并入策略（否则官方会整条拒绝该次调用），
   告警一次。

官方 `sandbox-policy` 自身也会拒绝缺失/非目录/符号链接根（包括两次调用之间被换成
符号链接的情况），两侧叠加后沙盒内 agent 无法通过替换目录扩大授权。

**降级可见**：插件初始化失败（例如 `sandboxPolicy` 服务形状变化）时不会静默——
卡片顶部显示「额外根当前未生效：<原因>」，`get()` 结果带 `degraded`。

> 安全提示：这些目录可获得「写」权限（读本就不受限），请只保留确需写入的工具
> 缓存；含明文凭证的目录（如 `~/.docker`、`~/.dotnet`、`~/.gradle`）谨慎列入。

## 实现说明

- 强制路径：包装官方 `ctx.sandboxPolicy.resolve()`（service 方法，public 面）——在
  `workspace-write` 模式下把配置根并入返回策略的 `additionalWritableRoots`，随后官方
  Seatbelt/bwrap/Landlock 与文件系统围栏按同一字段生效。合并只做追加与去重（官方已有
  根在前），无增量时原样返回官方引用；挂载点引用计数，最后一个退出才还原原方法。
- Windows：额外根是否生效以官方 `sandbox-policy`/runner 对该字段的支持面为准（本插件
  不再按 runner 分平台分支，也不再自行拼接 ACL 参数）。
- 设置页读写走 Remote 服务面：`src/remote.ts` 用官方 `@Remote` 标准装饰器声明，
  参数/返回类型在 `src/types.ts`；客户端消费的 `./remote` 调用面与宿主侧 `./typert`
  工件由官方 `@deepseek-ai/dsh-typert-generator` 在构建期生成（**不要手写工件**）。
- 保存失败按官方 `RemoteError` 归一化：`sandbox-extra-roots/invalid-config`（配置被
  校验拒绝，details 带 `field`/`value`）与 `sandbox-extra-roots/config-unavailable`
  （当前部署没有 configEditor，无法持久化）；客户端按 code 给出本地化提示。
- 写回以官方 `configEditor.edit(current, inherited)` 的当前值为合并基（只并入
  `extraWritableRoots` 白名单字段），不会覆盖 profile patch 里的其它 key，也不会
  把 bundle 继承层固化成 override。

## 已知限制

- **Windows 不支持额外可写根（进程沙盒）**：官方 Windows ACL 进程沙盒
  （`@deepseek-ai/dsh-sandbox-local` 的 `windows-acl` rung）不消费
  `SandboxExecutionPolicy.additionalWritableRoots`——0.2.2-rc.1 在
  `workspace-write` 且存在额外根时会在 `confine()` 直接抛
  `SandboxUnsupportedPolicyError`（`sandbox-local` 的 `windowsAclRunnerArgv`；
  官方 README 也只承诺 Seatbelt/bwrap/Landlock 支持该字段）。因此本插件在
  Windows 上**不会**把配置的额外根并入官方策略（否则每条受限命令都会失败），
  设置卡显示「额外可写根当前未生效」；文件工具的 fs fence 在该平台同样不会获得
  这些额外根。需要额外可写目录时请把工作区放在目标路径下，或改用 macOS/Linux。
