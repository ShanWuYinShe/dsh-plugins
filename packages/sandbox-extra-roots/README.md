# @chaoset/sandbox-extra-roots — DSH 沙盒额外允许目录插件

给 dsh 沙盒的 `workspace-write` 模式增加「额外允许写入的目录」列表（工具缓存
目录等），**官方白名单始终保留**（workspace 根 + /tmp + 平台临时目录），只追加
不替换：

- **bash**：Seatbelt（macOS）重建 SBPL profile；bwrap / Landlock（Linux）在官方
  profile 基础上插入 `--bind` / `--rw`；Windows ACL runner 无法表达额外根（告警一次）
- **fs fence**：`checkedTarget` 对额外目录放行，其余委托官方实现
- 幂等、可热切换（挂载点引用计数）；首次 confine 时自检官方 profile 是否漂移

## 安装

> 适配的 DSH 版本见本包 `package.json` 的 `dsh.host` 字段；仓库的 `dsh-v*`
> git tag 是各次稳定版适配的归档点。

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
4. **DSH 设置页 → 插件配置 → 沙盒额外允许目录**（保存到
   `~/.dsh/plugins/sandbox-extra-roots/config.json`，立即热生效）

`extraWritableRoots`：绝对路径数组（设置页里每行一个，支持 `~` 表示用户主目录）。
相对路径/空值会被拒绝并告警；危险根（`/`、盘根、主目录本身及其父目录，如
macOS 的 `/Users`）保存时直接拒绝，系统目录（`/etc` `/usr` `/bin` `/sbin` 及
macOS 的 `/private`，仅 POSIX——Windows 暂无对应条目）被过滤，重复行自动去重。
设置页卡片在保存前就地预览这些问题行（危险/无效行会禁用保存按钮；系统目录
行保存成功但不生效）。常用工具缓存（npm/pip/gradle 等）可一键添加进列表，
点选即视为用户显式确认；含明文凭证的目录不在预设内。运行期每次
沙盒判定都会对目录的最新真实指向（跟随符号链接后）重新做危险根复查——目录
被替换成指向 `/` 等危险根的符号链接时立即剔除，不授予。

> 安全提示：这些目录可获得「写」权限（读本就不受限），请只保留确需写入的工具
> 缓存；含明文凭证的目录（如 `~/.docker`、`~/.dotnet`、`~/.gradle`）谨慎列入。
