# Changelog

## 0.3.13 (2026-09-10)

### Changes

* 跟进 DSH 稳定版 0.1.5-rc.1（合并 alpha 线 0.3.13-alpha.0 ~ alpha.1 的适配
  内容）：全部 `@deepseek-ai/dsh-*` 依赖由 `^0.1.2-rc.1` 升至 `^0.1.5-rc.1`，
  `dsh.host` 更新为 `0.1.5-rc.1`
* 适配 0.1.5 起的 provider 契约：`ResolvedPiAiProviderProfile` 新增必填的
  `modelErrors`（解析失败模型的诊断），本插件补传空 Map（catalog 只含已成功
  解析的模型，与宿主自身缺省一致），否则 typecheck 不过
* 对齐上游 `@deepseek-ai/dsh-llm-pi-ai` 依赖更新：`@earendil-works/pi-ai`
  由 `^0.84.2` 升级为 `^0.85.1`，消除类型冲突
* build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.3.12 (2026-09-05)

### Refactoring

* 可维护性清理，无功能变更：`readOwn` 的死分支简化（`isENOENT` 判断
  与返回值同义）并补「与 readDesktop 策略差异是有意的」注释；30 秒双重
  语义拆分为 `MIN_REFRESH_INTERVAL_MS`（刷新节流窗口）与
  `MIN_REUSABLE_LIFETIME_MS`（可容忍寿命），`DEFAULT_REFRESH_MARGIN_MS`
  提常量；client 注释里的测试路径更新。

## 0.3.11 (2026-09-05)

### Fixes

* 上一版本（0.3.10）的 `dsh.host` 字段因改动散落两个工作树未随发布提交进入发布产物——本版本重新包含该字段。此外无任何变更。

## 0.3.10 (2026-09-05)

### Metadata

* package.json 新增 `dsh.host` 字段：声明本包适配的 DSH 版本，随每次
  宿主适配由 `adapt-dsh.mjs` 自动维护；`npm view <包名> dsh.host` 可查，
  README 安装节与仓库 `dsh-v*` 归档 tag 同步标注。无功能变更。

## 0.3.9 (2026-09-05)

### Fixes

* 修复自有凭据副本读回时过期时间恒为 0 的字段名不对称（副本序列化
  `expiresAtMs`，解析只认桌面文件的 `expiresAt` 拼写）：副本的
  needsRefresh 恒真，每条请求都会打一次刷新端点（存量副本读回时自动
  兼容两种拼写）
* 刷新成功但副本落盘失败时，刷新成果（可能含上游轮换后的一次性
  refresh token）保留在内存兜底中，不再退回磁盘旧副本——否则下一次
  刷新必然 session_dead、整个登录态报废；告警消息明确区分「落盘失败」
  与「上游刷新失败」（host 侧经 ctx.logger，CLI 默认 console.warn）
* 刷新响应缺 `expiresIn` 时按保守下限（10 分钟）外推过期时间，不再
  沿用已进入刷新窗口的旧值
* 新增 30 秒刷新节流：token 未真正过期时，极短有效期或缺 expiresIn
  的上游响应不再把刷新端点打成每请求一次

## 0.3.8 (2026-09-03)

### Changes

* alpha 线合并 + 稳定线跟进 DSH 0.1.2-rc.1：`@deepseek-ai/dsh-*` 依赖线由
  `^0.1.1-rc.2` 升到 `^0.1.2-rc.1`，并合入 alpha 线的 0.1.2 宿主适配（功能
  与 0.3.7 一致，不含新功能）
* 0.1.2 线破坏性 API 适配（自 alpha 线合入）：上游移除了
  `settingsNamespace()`——命名空间现为普通字符串（`'anyconnect'`，附
  `SettingsNamespace` 类型标注）；`installSettingsSection()` 自由函数改为
  provider 服务上的 `settings.installSection()`，经
  `ctx.inject(['settings'], …)` 延迟装配；client 的 `ClientContext` 改由
  `@deepseek-ai/cordis` 引入并补 `dsh-client-ui-renderer` 副作用导入；
  上游在 0.1.2 线删除了 `dsh-client-runtime` 包（止于 `0.1.1-rc.2`），本包
  依赖同步移除
* 已对照 0.1.2-rc.1 全量 diff 官方包（36 个：逐包与 0.1.2-alpha.5 字节对比，
  除版本号外零差异——rc.1 是纯转正 bump）：settings / llm / llm-pi-ai /
  client-ui-settings-plugins / client-ui-slots / attachment 各契约面与
  alpha.5 适配时一致，运行时逻辑无需调整；全仓 build + typecheck + 162 项
  测试在 rc.1 依赖闭包上通过

## 0.3.7 (2026-09-03)

### Changes

* 思考强度按模型精确对齐实际可用集：声明了 `supportedEfforts` 的模型恰好
  提供声明的档位；未声明的旧目录行只提供其 `defaultEffort` 一档。依据：
  上游 wire 不校验 effort 值（无效值同样 200），且对旧模型实测 minimal 与
  max 的思考量无差异——旧模型上提供可选强度是虚假控制
* 移除设置 → 通用设置中的 WorkBuddy 剩余积分行（设置 → 插件的卡片已有
  完整额度展示）

与 alpha 线的 0.3.8-alpha.0 内容对应（宿主依赖线不同：本版锁 `^0.1.1-rc.2`）。

## 0.3.6 (2026-09-03)

### Changes

* 剩余额度展示迁位：从侧栏底部动作位（数据徽章混在归档/设置按钮间，语义
  与视觉都不合）迁至设置 → 通用设置的一行，与语言/外观等全局偏好并列；
  行自绘标签与数值（WorkBuddy 剩余积分 · 43），未登录或无数据时不渲染；
  详情（分包进度条、模型优惠）保持在设置 → 插件的卡片

与 alpha 线的 0.3.7-alpha.0 内容对应（宿主依赖线不同：本版锁 `^0.1.1-rc.2`）。

## 0.3.5 (2026-09-03)

### Bug Fixes

* 修复侧栏额度徽章与设置卡片在浏览器中崩溃（`ReferenceError: React is not
  defined`）：client 构建的 JSX 此前回落 classic 转换，产物引用裸
  `React.createElement`，页面无全局 React 即崩。构建脚本显式
  `jsx: automatic` 并将 `react/jsx-runtime` 设为 external（宿主 ModuleLoader
  已映射该模块，官方 client 插件即此形态）
* 模型下拉框不再显示模型介绍文案：倍率只随模型名显示
  （`GLM-5.2 · x0.79`），description 不再携带内容，消除费率重复

与 alpha 线的 0.3.6-alpha.0 内容对应（宿主依赖线不同：本版锁 `^0.1.1-rc.2`）。

## 0.3.4 (2026-09-03)

### Features

* 主页面侧栏底部新增 WorkBuddy 剩余额度徽章（`sidebar.footer.action` 槽位）：
  每 2 分钟静默轮询，未登录或无额度数据时不渲染；侧栏收起退化为纯数字
* 模型费率去重：倍率只保留在模型名后缀（`GLM-5.2 · x0.79`），模型描述不再
  重复展示倍率，改为携带上游的模型文案（按登录区域取中/英文）

与 alpha 线的 0.3.5-alpha.0 内容对应（宿主依赖线不同：本版锁 `^0.1.1-rc.2`）。

## 0.3.3 (2026-09-03)

### Bug Fixes

* 修复全新安装后读取不到桌面端登录态：settings 文档把未设置的 `authFile`
  物化成空串并原样传给 `setDesktopPath`，空串覆盖把桌面凭据探测路径钉死为
  单个空路径，整包被判定为未登录（status 接口返回 signed-out，设置页卡片
  因此没有账号与额度内容）。空串/纯空白覆盖现在回退到平台默认探测顺序，
  与空环境变量的既有行为一致

与 alpha 线的 0.3.4-alpha.0 内容对应（宿主依赖线不同：本版锁 `^0.1.1-rc.2`）。

## 0.3.2 (2026-09-02)

### Bug Fixes

* 额度统计计入未开始的周期授予：周期型套餐当月额度用尽但 `RemainCycles > 0`
  时，真实剩余 = 当前周期剩余 + 未开始周期数 × 周期额度——此前只算当前周期，
  会把还有后续周期的套餐显示成 0；卡片进度条分子分母同步跨同一范围
* 插件卡片的免费模型不再显示「x0.00 积分/次」速率行（免费徽章已表达该事实），
  促销模型的倍率行保持不变
* 静态兜底模型目录对照 2026-09-02 线上数据复核：15/15 完全一致

与 alpha 线的 0.3.2-alpha.1 内容对应（宿主依赖线不同：本版锁 `^0.1.1-rc.2`）。

## 0.3.1 (2026-09-02)

### Changes

* npm 包名定为 `@chaoset/dsh-any-connect`（原迁移时的 `dsh-anyconnect` 因
  unpublish 后 24 小时同名保护无法复用，且更清晰的连字符命名与 monorepo 目录
  `packages/dsh-any-connect` 一致）。同步更新：heartbeat `package` 字段、
  status 路由路径、CLI 命令名（`dsh-any-connect`）、client 插件名、
  `cordis.patch.yml`。内部标识（provider 路由 `workbuddy`、设置命名空间
  `anyconnect`）不变——它们是接入的 Agent 名与产品标识，非包名。

## 0.3.0 (2026-09-02)

本包的第一个独立版本：由 corrinehu/dsh-workbuddy-connect 迁移而来，纳入
dsh-plugins monorepo，标识改为 @chaoset/dsh-any-connect（插件名
`llm-anyconnect`、设置命名空间 `anyconnect`；provider 路由保留 `workbuddy`）。

### Features

* 费率显示：模型选择列表每个模型名直接带积分倍率（`GLM-5.2 · x0.79`），
  `/model` 弹窗与 composer 下拉都可见；设置卡片「模型优惠」区块含倍率行、
  免费 / 限时免费 / 夜间折扣徽章。`normalizeCredits` 把上游 `x0.79 credits`
  归一成语言无关的 `x0.79`（host 侧 LLM seam 无 locale 服务）
* 思考强度：解析上游 `reasoning` 的 `supportedEfforts` / `canDisableThinking`，
  逐模型映射 pi-ai 思考等级；旧形态行提供完整档位，`off` 仅当
  `canDisableThinking:true` 才提供
* `developer` → `system` 角色改写：pi-ai 把系统提示作为 `role:"developer"`
  发送，WorkBuddy 上游拒绝该 role（HTTP 400 code 11128）
* 兜底目录同步到 cli 的 15 个模型（新增 hy4-preview / hy3-x / glm-5.3 /
  glm-5.3-flash）
* 保留 `dsh-any-connect` CLI（doctor / status / logout，含宿主心跳检测）
* 版本改为运行时读 `package.json`（monorepo 用 tsc 构建，无 tsdown `define`；
  顺带消除"发布产物报旧版本号"的失败模式）

### Notes

* 本包锁 dsh 0.1.1-rc.2 稳定线依赖；适配 dsh alpha 的版本在 alpha 分支维护
* 基于 upstream 的 LICENSE 为 MIT；README 顶部声明了来源与致谢
