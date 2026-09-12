# Changelog

## 0.4.11 (2026-09-12)

### Fixes

* 危险根校验升级词法祖先判定：授予危险根的任一祖先等价于授予该危险根本身。
  此前只做精确相等匹配，授予 `/Users`（macOS）或 `/home`（Linux）等于放开
  整个 home 区、授予 `/private` 等于放开其下 canonical 后的 `/private/etc`
  等系统目录。现 home 的祖先按 reject 拒绝、系统目录的祖先按 filter 剔除；
  危险根的后代比危险根更窄，照常放行
* Seatbelt 的内部命令改从 `--` 分隔符之后定位（此前硬编码 `slice(3)`，官方
  在 `-p` 前后追加参数会静默错位）；分隔符缺失（契约漂移）时保持官方 argv
  原样并告警一次，与 bwrap/Landlock 同策略
* 目录存在性缓存声明上移到配置存储创建之前：配置热更新回调引用它，构造期
  同步触发回调会触发 TDZ ReferenceError
* fs 侧放行路径的 `resolve` 显式绑定底层实例：宿主以解绑形式调用
  `checkedTarget` 时不再以插件内部 TypeError 盖过官方的 `FS_SANDBOX_DENIED`
  拒绝文本
* 新增 2 用例（home 祖先拒绝/后代放行并断言授予生效、macOS `/private`
  过滤）；build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.4.10 (2026-09-11)

### Changes

* 跟进 DSH 稳定版 0.1.5-rc.2：`@deepseek-ai/dsh-sandbox` 与
  `@deepseek-ai/dsh-typert-protocol` 依赖由 `^0.1.5-rc.1` 升至
  `^0.1.5-rc.2`，`dsh.host` 更新为 `0.1.5-rc.2`（rc.2 与 rc.1 逐包对比
  源码零差异，纯依赖 range 重发，无适配代码改动）

### Fixes

* 修复设置页「沙盒额外允许目录」卡片不渲染：本插件注册的 settings
  namespace `sandboxExtraRootsConfig` 含大写字母，不满足宿主 dsh-settings
  的 `^[a-z][a-z0-9-]*$` 校验，`settings.register()` 抛 TypeError 且在
  inject 回调里被静默吞掉；设置页 describe 镜像因此不含本插件 namespace，
  卡片（按 namespace 配对）从不出现。现改为 `sandbox-extra-roots-config`，
  宿主侧注册与客户端卡片 key 同步改名；typert 远程通道与 config.json
  存储不受影响。已在隔离实例实测卡片渲染与保存落盘恢复正常

## 0.4.9 (2026-09-10)

### Changes

* 跟进 DSH 稳定版 0.1.5-rc.1（合并 alpha 线 0.4.9-alpha.0 ~ alpha.1 的适配
  内容）：`@deepseek-ai/dsh-sandbox` 与 `@deepseek-ai/dsh-typert-protocol`
  依赖由 `^0.1.2-rc.1` 升至 `^0.1.5-rc.1`，`dsh.host` 更新为 `0.1.5-rc.1`
* build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.4.8 (2026-09-05)

### Refactoring

* 可维护性清理，无功能变更：修正 confine 包装区「1./1a.」重复标题
  （前一块实际是 sandboxAvailable 可用性检查）。

## 0.4.7 (2026-09-05)

### Fixes

* 上一版本（0.4.6）的 `dsh.host` 字段因改动散落两个工作树未随发布提交进入发布产物——本版本重新包含该字段。此外无任何变更。

## 0.4.6 (2026-09-05)

### Metadata

* package.json 新增 `dsh.host` 字段：声明本包适配的 DSH 版本，随每次
  宿主适配由 `adapt-dsh.mjs` 自动维护；`npm view <包名> dsh.host` 可查，
  README 安装节与仓库 `dsh-v*` 归档 tag 同步标注。无功能变更。

## 0.4.5 (2026-09-05)

### Fixes

* 安全：confine 与 fs fence 每次调用重新 canonical 化（跟随符号链接）
  之后，对最新指向重跑危险根复查——沙盒可写区内的额外目录被替换成
  指向 `/`、主目录等危险根的符号链接时立即剔除、不授予。此前危险根
  过滤只在配置期执行一次，「跟随重定向」会被符号链接交换反制成沙盒
  逃逸通道（bash profile 与文件工具双双全盘可写）
* `dsh.d.ts` 的 confine 签名与官方同步实现对齐（返回包装对象而非
  Promise），消除类型层面的契约误导

### Docs

* README 补充运行期符号链接重定向的防护说明

## 0.4.4 (2026-09-03)

### Changes

* alpha 线合并 + 稳定线跟进 DSH 0.1.2-rc.1：`@deepseek-ai/dsh-sandbox` 与
  `@deepseek-ai/dsh-typert-protocol` 由 `^0.1.1-rc.2` 升到 `^0.1.2-rc.1`
  （合入 alpha 线 0.4.4-alpha.0 / 0.4.4-alpha.1 的适配内容，功能与 0.4.3
  一致）
* 已对照 0.1.2-rc.1 全量 diff 官方包（36 个：逐包与 0.1.2-alpha.5 字节对比，
  除版本号外零差异——rc.1 是纯转正 bump）：dsh-sandbox 的 `canonicalPath` /
  `writableRoots` / `SandboxProvider.confine` 签名与 alpha.5 适配时一致，
  运行时逻辑无需调整；全仓 build + typecheck + 162 项测试在 rc.1 依赖闭包
  上通过

## 0.4.3 (2026-08-29)

### Features

* 设置卡片初次读取配置时在状态栏显示 spinner +「加载中…」（respect
  `prefers-reduced-motion`）：此前只显示禁用的空白表单，无法区分加载中与加载失败

## 0.4.2 (2026-08-28)

### Bug Fixes

* 支持从源码运行的 DSH：官方包解析链首插安装闭包共享 fallback
  `$DSH_HOME/profiles/node_modules/<pkg>`（harness 启动时 heal 的依赖闭包
  symlink 镜像），以 realpath 导入保证与 harness 同一模块实例；失败回落原有
  解析链。全局不安装 `@deepseek-ai/*`、`dsh plugin add` 本地路径链接安装时，
  官方包不再依赖 profile 内的 npm 副本。已对照 dsh 源码 0.1.2-alpha.1 复核
  sandbox/fs 契约无变化

## 0.4.1 (2026-08-28)

### Bug Fixes

* 适配 DSH 0.1.1-rc.2：`@deepseek-ai/dsh-sandbox`、
  `@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/node-addon-landlock-run`
  依赖 range 从 `^0.1.0-rc.8` 升到 `^0.1.1-rc.2`（npm semver 的 prerelease
  规则下旧 range 无法匹配 `0.1.1-rc.2`，新版宿主下会解析到旧官方包或直接失败）
* fs fence 包装对 `sandboxPolicy` 的解析加防御：宿主策略服务缺失/契约变化时
  rethrow 原始 `FS_SANDBOX_DENIED`，插件内部异常不再盖过沙盒拒绝语义
* 已对照 0.1.1-rc.2 的 `dsh-sandbox-local` 复核：Seatbelt SBPL profile、
  bwrap/Landlock argv 契约无漂移（仅新增 `--unshare-pid` 与 read-only 分支
  重构，插件在 `--` 前插入额外根的方式不受影响）

## 0.4.0 (2026-08-25)

### Features

* **`~` 展开**：设置页允许 `~` / `~/x` 拼写，host 在 validate 与 normalize
  两个入口前统一展开为用户主目录——最常见的缓存目录写法不再被「非绝对路径」拒绝
* **保存前即时反馈**：设置卡片在编辑期词法预检草稿并逐行提示将被拒绝/忽略/
  去重的条目（危险根 / 系统目录 / 非绝对路径 / 重复行）。此前 host 会在保存时
  静默剔除这些行并只打 host 日志，UI 一律显示「已保存」，用户以为生效了
* textarea 加 `spellCheck=false` 与示例 placeholder

### Bug Fixes

* 目录存在性判定加 5s TTL 缓存（配置热更新时整体失效）：bwrap/Landlock 每次
  confine 与 fs fence 每次拒绝复核不再逐根 `statSync`（同步 IO 落在 bash 启动
  热路径上）；代价是新建目录最多延迟 TTL 被授予，可接受

## 0.3.0 (2026-08-22)

### Features

* **危险根校验**：`remote.set` 拒绝规范化的 `/`、Windows 盘根（`C:` 等）与
  用户主目录本身（`TypeError`）——授予它们等于放弃沙盒边界；`normalizeRoots`
  告警并过滤系统目录（`/etc` `/usr` `/bin` `/sbin`）作为 patch/YAML 路径绕过
  严格校验时的兜底；字面与规范化拼写都匹配（覆盖 macOS `/etc → /private/etc`）
* 声明 `engines: { node: ">=22.19.0" }`

### Bug Fixes

* bwrap/Landlock 分支合并官方可写根与额外根（去重、剔除官方 argv 已授予的根）
  而非直接追加——不再有重复 `--bind`/`--rw` 授予，与 Seatbelt 重建 profile 的
  语义对齐
* 每次 confine/fs-fence 调用重新规范化额外根，符号链接重定向实时生效；fs fence
  与 bash 侧一致过滤非目录根——已配置但尚未创建的目录不再被 fs 预先授予
  （行为变更；Seatbelt 子路径匹配不受影响）
* 配置网关与 settings 命名空间注册移到核心沙盒包装之后并独立 try/catch：一侧
  失败不再影响另一侧
* client `locale.register` 对重复注册（HMR 重挂）静默容忍，其余错误仅告警
* `dsh.d.ts`：`sandboxPolicy.resolve()` 声明为同步——宿主契约是同步的，异步
  类型会诱导 await 把额外根从 fs fence 中静默丢失

## 0.2.9 (2026-08-22)

### Bug Fixes

* fail-safe 模块初始化：`@deepseek-ai/dsh-sandbox` 解析不到时降级为告警 +
  no-op，不再让顶层 await rejection 中断 harness 启动
* 设置卡片编辑期保留 textarea 原始草稿（换行只在保存时解析）——此前输入
  `/tmp/a` ⏎ `b` 会被静默合并成 `/tmp/a/b`

## 0.2.8 (2026-08-22)

### Dependencies

* 对齐 `@deepseek-ai/*` 与 dsh 0.1.0-rc.8

## 0.2.7 (2026-08-22)

* 重新发布 TypeScript 重构后的构建产物（无运行时变化）

## 0.2.6 (2026-08-17)

### Bug Fixes

* 注册设置命名空间时把实时配置快照作为 `base` 传入：无默认值的 schema 曾使
  `settings.describe()` 返回 `value: undefined`，设置页 wire 校验失败、整个
  设置 UI 挂掉；传入 `base` 后返回值始终是完整配置对象

## 0.2.5 (2026-08-17)

### Bug Fixes

* 把配置命名空间注册进宿主 settings 服务（`ctx.settings.register`），设置页
  「插件配置」tab 才会列出卡片。注册只管可见性，卡片读写仍走插件自己的配置
  网关（config.json 权威、热更新保留）；settings 服务缺失时 fail-safe，
  重复注册（HMR）静默忽略

## 0.2.4 (2026-08-17)

### Bug Fixes

* 设置卡片注册补 `key`（settings 命名空间，与 host 侧 service key 一致）：
  宿主 `dsh-client-ui-slots` 0.1.0-rc.7 声明为 keyed slot，缺 `key` 会让整个
  client bundle 激活失败（"Failed to load plugins: keyed slot requires options.key"）

## 0.2.3 (2026-08-16)

### Bug Fixes

* `engines.node` 提到 >=22.19.0（node 20 已 EOL）

## 0.2.2 (2026-08-16)

### Bug Fixes

* 经 typert-loader host artifact（lib/typert.host.js）注册配置网关端点，
  api-gateway 不再受模块实例身份影响：npm registry 安装时包内 typert-protocol
  副本与 harness 不同源，Remote 装饰器 SRC 标记对网关不可见，设置页调用报
  "transport failure ... HTTP 404"

## 0.2.1 (2026-08-16)

### Bug Fixes

* client bundle 挂载远程配置命名空间（修复 web boot "did not activate"）

## 0.2.0 (2026-08-15)

### Features

* 插件转为 DSH bundle 安装方式
* host 插件包（vision-router + sandbox-extra-roots）：设置 UI、远程配置网关、
  双模式安装
* 加固插件并简化 vision 图片替换

### Bug Fixes

* file:// 部署懒加载官方依赖；补测试套件与文档
