## 0.4.17 (2026-09-25)

### 优化

* **适配 DSH 宿主 0.1.7-rc.2 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.1.7-rc.2`。

# Changelog

## 0.4.16 (2026-09-25)

### 新增

* **常用工具缓存一键添加**：设置页预设 chips（npm/pip/cargo/go，按平台过滤），点选即追加进列表并走同一套保存前校验；含明文凭证的目录永不进预设。

## 0.4.15 (2026-09-25)

### 修复

* **主题变量拼写修正**：未保存徽标改用 `--dsw-alias-state-warn-primary`、等宽字体改用 `--ds-font-family-code`（此前两个名字宿主不存在，暗色/高对比主题下静默回退硬编码）；配套新增 CSS 变量白名单回归测试。
* **错误消息独立展示**：保存/加载失败改走块级 `role="alert"`（此前复用 footer 状态行）。
* **apply 加 slot 兜底边界**：与 dsh-any-connect / provider-usage 一致，slot API 破坏时降级 console 而不是炸宿主红条。
* **set 网关参数加真 schema 校验**：畸形输入在方法分发前即被拒绝。

### 优化

* **展开卡片时静默重读配置**：CLI/别处改过后页面不显示陈旧值；有未保存编辑时不覆盖，dirty 按新基准重算。
* **成功提示 5 秒自动消失**：与 session-archive 的 notice 策略统一；错误常驻到下一次编辑。
* **无障碍**：折叠头关联 `aria-controls`，问题行 emoji 前缀对读屏隐藏。

## 0.4.14 (2026-09-24)

### 优化

* **路径校验分级视觉指示**：对不可用、不存在、警告提示等路径校验结果提供差异化语义图标与渐进色彩标识。
* **等宽字体统一**：路径输入框与列表展示统一使用 DSW 等宽字体 Token（`var(--dsw-font-family-mono)`），确保跨平台排版整齐。

## 0.4.13 (2026-09-24)

### 优化

* **UI 交互质感打磨**：卡片圆角统一为 12px，优化边框、未保存警告琥珀色徽标与输入框聚焦光晕（Focus Ring）。
* **保存阻塞逻辑重构**：将保存判据抽离为具名函数 `hasBlockingProblems`，保证与单测及导出契约一致。
* **适配 DSH 宿主 0.1.7-rc.1 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.1.7-rc.1`。

## 0.4.13-alpha.5 (2026-09-24)

### 优化

* 卡片圆角统一为 12px 并增强边框与阴影过渡。
* 未保存修改徽标调整为醒目的警告琥珀色。
* 路径多行输入框增加品牌主色聚焦高亮光晕（Focus Ring）与平滑过渡。
* 操作按钮微调内边距与 hover 反馈。

## 0.4.13-alpha.4 (2026-09-23)

### 重构

* 保存按钮的「阻塞级问题」判据抽成入口级具名函数 `hasBlockingProblems`（组件与
  导出的客户端入口共用）：此前该判据只存在于组件内联表达式里，单测只能在用例
  中自造一份局部谓词，产品改了禁用条件测试照样绿——对产品零覆盖。现在的单测
  直接调用产品判据，并逐个钉住 invalid / danger / homeAncestor 三个 kind
  （变体验证：判据里删掉任一个 kind，用例即红）。

## 0.4.13-alpha.3 (2026-09-23)

### 适配

* 跟进 DSH 宿主 0.1.7-alpha.2：依赖 range 与 `dsh.host` 同步，无代码改动。

## 0.4.13-alpha.2 (2026-09-22)

### 适配

* 删除 `registerSettingsNamespace` 及其调用——卡片可见性由
  Loader profile entry 与 `plugins.bundle.config` slot 决定，卡片读写仍走
  config gateway。核心沙盒包装无改动。

## 0.4.13-alpha.1 (2026-09-17)

### 适配

* 配置卡片改由 `plugins.bundle.config` 承接（key 为 npm 包名），显示在本插件
  的 Plugins 页（描述与组件列表之间）；非 page 视图防御性返回一句话
  summary（该 slot 契约只 dispatch page），view 判断留在无 hooks 的外层组件
* TypertCodec 改用惰性 `create` 工厂（typert-loader
  强制校验 `create()` 存在）：客户端
  `$mount` 描述符与 `typert.host` 工件同步迁移

## 0.4.13-alpha.0 (2026-09-15)

### Fixes

* 同步稳定线 0.4.12 的全仓审查修复：Seatbelt 漂移自检改 fail-closed
  （检出漂移放弃重建、保持官方 argv，bash 侧额外根随之失效并告警）、
  fs 侧包装内部异常兜底 rethrow 官方 `FS_SANDBOX_DENIED`、客户端预览补
  `/private`、主目录祖先与裸 `~` 的 danger 判定（阻塞级行禁用保存）
* `confine` 包装为 `async`：`await` 原实现并把第三参数 `signal` 透传
  （宿主 terminal-bash 以 `await` + `signal` 调用），否则 `wrapped.argv`
  为 `undefined`、每次 bash 执行都抛 `TypeError`；`dsh.d.ts` 宿主契约同步
  更新。测试 mock 覆盖 async + signal 透传；在真实 `dsh-sandbox-local`
  （bwrap）上端到端验证额外根注入

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

* 功能与 0.4.3 一致（依赖基线同步）

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
  官方包不再依赖 profile 内的 npm 副本

## 0.4.1 (2026-08-28)

### Bug Fixes

* fs fence 包装对 `sandboxPolicy` 的解析加防御：宿主策略服务缺失/契约变化时
  rethrow 原始 `FS_SANDBOX_DENIED`，插件内部异常不再盖过沙盒拒绝语义

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
