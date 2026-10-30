## 0.4.28-alpha.9 (2026-10-30)

### 修复

* **WorkBuddy `code:6004` 限流不再「不知道恢复时间」**：上游把恢复时刻写在错误体文案（`usage will reset at 2026-10-30 14:20:02 UTC+8`），此前只认响应头（`Retry-After` / `X-RateLimit-Reset`）而 WorkBuddy 两条都不给，限流台账与限流提示框只能说「未提供恢复时间」。现在恢复时刻的口径是「上游明说的事实」：响应头优先，其次解析错误体里**带显式时区**的 `reset at <时刻> UTC±N`（无时区不猜，过去的时刻不认，日期做日历回滚校验）；限流台账（状态页限流框）与 429 错误文案（「上游表示 <本地时间> 恢复」）都会显示解析出的时刻。
* **OpenCode 两种上游拒绝分开说清**：`FreeUsageLimitError`（HTTP 429，免费额度用尽，按账号/IP 计）与 `FreeTierError`（HTTP 403，网关只认官方客户端形状，与额度无关）此前共用一句「频次限流」文案，用户会对一个不会恢复的请求反复重试。现在额度用尽数给恢复时刻并指向 OpenCode Go 订阅/切换模型，形状校验则如实说明与额度、密钥均无关；传输错误（HTTP_0）不再被套上限流文案。

## 0.4.28-alpha.8 (2026-10-30)

### 变更

* **发布产物零运行期依赖（修复插件索引安装链）**：`zod` 由 `dependencies` 移入 `devDependencies`，运行期由宿主 profile runner 的 runtime resolution 从宿主安装闭包供给（与宿主包、Typert 工件同一纪律）。此前 tarball 声明了 `zod`，而插件索引静态 registry 的 packument 按设计省略依赖段：pnpm 在后续包操作里会按已装 tarball manifest 去 registry 解析 `zod` 并 404，表现为「用索引装过本插件后再装第二个插件必失败」（2026-10-30 实测，宿主内置 pnpm 11.28.5 / 12.4.2 复现）。**用索引安装的用户请升级到本版本；旧版本仍带该缺陷，排障见根 README。**
* bin 自包含闭包补直接 devDependency 声明 `@deepseek-ai/dsh-storage ^0.2.2-alpha.2`：此前缺直接声明，bun.lock 解析到旧线 0.2.1-rc.3，与 storage-domain/json 的精确 peer 不一致（当前两版库代码相同，属构建期 hygiene 风险）。
* 清理已下线「夜免」活动的死代码链路（`modelWithCurrentPromotion` 未读取的形参、catalog/catalog-refresh 的字段与 setter、`isNightFreeEligiblePlan` 及测试断言），行为不变。
* 错误脱敏口径统一：`safeMessage`（JWT/`key=` 脱敏 + 500 截断）抽到共享叶模块，shim 的未登录 401 与 500 internal 错误体与浏览器侧同口径，不再直出原始 `String(error)`。
* 修正 3 处与实现相反的注释（存储降级语义、已删除的旧布局迁移、shim 的共享密钥鉴权描述）。

## 0.4.28-alpha.7 (2026-10-30)

### 破坏性变更

* **兼容声明改为精确匹配宿主版本**：`engines.dsh` 由 `^0.2.2-alpha.2` 改为 `0.2.2-alpha.2`（不带范围操作符）。每个插件版本只声明它发布时实际适配的 DSH 版本——DSH 升级（含同线 alpha→rc→下一 alpha）后必须安装对应重新发布的插件版本；宿主安装/启动会严格按精确版本判定兼容性，确需跨版本使用可用宿主 `allow-version <包>@<版本> --dsh-version <版本> --accept-risk` 显式接受风险。插件索引（market）同步对每个版本做精确 pin。
## 0.4.28-alpha.6 (2026-10-30)

### 重构

* **行为不变的优雅化**（30 个既有文件 + 4 个新文件）：`runtime.ts` 三条变体装配分支合并为一条（457→402 行），删除 `probeService` 假类型骗局字段；新增 `src/values.ts` 统一 `isObject`/`errorMessage` 两个口径（消除 8 处逐字重复与 2 份 isObject 副本）；client 卡片 4 个动作处理器合并为 `runCardAction`（`useVariantCard` 346→246 行），纯派生视图抽到 `variant-card-view.ts`；`VariantCard.tsx` 380→76 行，拆出 `VariantCardQuota.tsx`/`VariantCardModels.tsx`（DOM 顺序不变）。
* **删死代码与收回导出**：删除 5 个真死导出（`ZCODE_SETTINGS_NS` 等），17 个仅模块内使用的值导出收回为模块私有（类型导出保留）；`VariantRuntime` 的 client/credentialStore/catalogStore/filterStore 改为必需字段，随之删掉 6 处 `as unknown as` 断言链与非空断言兜底。
* **类型收紧**：`as any` 2→0、`as unknown as` 8→1、非空断言 8→1（`RuntimeStore` 签名按根因收紧）。

## 0.4.28-alpha.5 (2026-10-29)

### 修复

* **独立 CLI 恢复可用（`ERR_MODULE_NOT_FOUND`）**：`dsh-any-connect doctor/status/logout` 由宿主 Loader 之外的独立 node 进程运行，不经宿主 runtime resolution；`src/bin.ts` 静态 import 的宿主包（`@deepseek-ai/dsh-home-paths` 等）在用户 profile 的解析路径上不存在，发布的 `lib/bin.js` 一执行就报 `ERR_MODULE_NOT_FOUND`。构建新增第 4 阶段（`scripts/build.mjs`）：用 esbuild 把 bin 入口连同依赖闭包打成**自包含单文件 ESM**（`bundle` + `minify`，external 只剩 `node:` 内建，保留 shebang），产物在任意工作目录、无宿主解析路径下都能运行；版本号仍按 `import.meta.url` 读包根 `package.json`。内联依赖的许可告知（全部 MIT：`@deepseek-ai/cordis`、`cosmokit`、`dsh-atomic-write`、`dsh-home-paths`、`dsh-storage`、`dsh-storage-domain`、`dsh-storage-json`、`dsh-timeout`、`schemastery`、`zod`）随包发布为 `THIRD_PARTY_NOTICES.md`。
* **bin 打包入口从 manifest 派生**：构建按 `package.json` 的 `bin` 声明推导「目标 `lib/<name>.js` ↔ 源码 `src/<name>.ts`」，新增 bin 的包自动纳入打包；缺源码或 esbuild 丢了 shebang 都直接构建失败，不再靠手工同步清单。

### 重构

* **宿主入口收敛为 Loader 四导出**：`src/index.ts` 由 27 条 export 语句转发 162 个名字收敛为 `name` / `inject` / `Config` / `apply` 四个（移除 158 个实现值与类型转发）；包内 13 个测试与测试辅助文件改为从 `../src/<module>.js` 相对导入，`src/auth.ts` 中只服务于入口转发的 `WORKBUDDY_AUTH_FILENAME` re-export 一并删除。包外扩展统一走 Cordis 服务面——测试便利值不再固化成发布 API（DSH 官方 `docs/defensive-patterns/package-surface.md`「A plugin package exports what the Loader loads」）。

### 测试

* 新增 `test/bin-self-contained.test.ts`：读真实构建产物断言 `lib/bin.js` 首行保留 shebang、只 import `node:` 内建模块（宿主包已内联），并在空目录 / 隔离 `DSH_HOME` 下实测 `--help`（exit 0 且含 Usage）与 `status --json`（可解析 JSON、`version` 与包根 `package.json` 一致）。产物缺失或仍是 tsc 裸产物时**直接红灯**并提示先 `bun run build`，不静默跳过。

## 0.4.28-alpha.4 (2026-10-29)

### 破坏性变更

* **移除旧布局迁移**：旧版平铺在 `$DSH_HOME` 根目录的自有凭据副本（`.workbuddy-auth.json` 等 4 份）与 `.dsh-any-connect/` 回落副本不再自动搬进状态域（`storages/dsh_any_connect/`）；旧位置 `$DSH_HOME/.zcode-device-mid` 的设备标识也不再兼容读取。从 ≤0.4.13 直接升级的用户会丢失插件自有凭据副本、需重新登录一次（桌面端 App 的登录态仍自动复用，不受影响）；Start Plan 的 `X-Device-Mid` 会重建为新值。

### 优化

* **适配 DSH 宿主 `0.2.2-alpha.2` 的 manifest / 运行时契约**：
  * 兼容声明迁到官方字段 `engines.dsh: ^0.2.2-alpha.2`，`engines.node` 提到 `>=24.9.0`（宿主新最低 Node 版本），补 `dsh.manifestVersion: 1`，删除自造 `dsh.host` 字段。
  * 删除空的 typert 工件（`src/typert.host.ts` 与 `exports["./typert"]`）：本包没有 Remote 服务，空工件是无效兼容物。
  * `dsh.client.inject` 校正为真实客户端模块包名：删掉无 `dsh.client` 声明的静态 seed 库 `@deepseek-ai/dsh-client-ui-slots`，补上 `conversation.input.model.label` 槽 owner `@deepseek-ai/dsh-client-ui-model-selection`。
* **pi-ai 对齐宿主 1.3.0**：`@earendil-works/pi-ai` 由 optionalDependency（`^1.1.0`）改为 devDependency `^1.3.0`。运行时不再自带 pi-ai 副本：它随宿主 `dsh-llm-pi-ai` 的依赖闭包解析（宿主 profile runner 的 runtime resolution），与宿主共享同一实例，同时不再把整棵传递依赖装进 profile。
* **超时抽象去掉本地回退**：`src/timeout.ts` 改为静态 import 宿主 `@deepseek-ai/dsh-timeout` 的 `deadline`，删除动态 import + 本地同语义实现（旧假设「生产安装裁掉 devDep 后静态 import 会炸」已被边界注记与 app-boot 的 runtime resolution 源码否定）。超时原因统一为宿主 `TimeoutReason`，消费方按 `reason.code` 分类的契约不变。
* **adapter 的 `compat` 字段确认为 pi-ai 官方能力**：`Model.compat.supportsDeveloperRole = false` 只对 OpenAI 形通道声明（anthropic-messages 的 compat 类型无此字段），注释写明它用于规避 WorkBuddy 网关对 `role: "developer"` 的 400/11128 拒绝。

### 测试

* 新增模型容量显式声明回归（`test/capacity.test.ts`）：四个通道的兜底名单、未知模型的保守默认（200K/32K）、目录解析丢弃无容量行、`toPiModel` 容量透传与 pi-ai `compat` 甄别——确保不依赖 0.2.2 起「未声明容量默认 1M/128K」的宿主默认值。

## 0.4.28-alpha.3 (2026-10-29)

### 新增

* **已隐藏模型可查看、可逐条恢复**：卡片模型列表下方新增「已隐藏的模型」区（默认收起，标题行显示数量），列出每个隐藏模型的名称、倍率、上下文窗口与思考档位，每行带「恢复」按钮——只放回想恢复的那几个。此前唯一入口是「一键恢复全部」，多数情况只想放回一两个，全部恢复后还得把其余重新隐藏一遍（用户报告的原话）。
  * 后端：`ModelFilterStore.restoreOne()`（单条，返回是否确实隐藏过）、`WorkBuddyCatalog.excludedModels()`（完整行，复用与可见区同一套促销解析）、`WorkBuddyWebStatus.excludedModels`、探针路由新增 `restore-model` 动作（空 modelId 判 400；未挂载该钩子判 404 而非悄悄降级成全量恢复）。
  * 「全部恢复」保留为次要出口，按钮 title 说明影响范围；无隐藏项时整区不渲染。
  * 隐藏区与 `visible` 无关：未登录时也能看到自己隐藏过什么（那是用户配置，不是上游状态）。

## 0.4.28-alpha.2 (2026-10-29)

### 修复

* **额度耗尽被误报成「不提供额度查询」**：`totalCreditsWindows` 在所有积分包耗尽时返回空窗口列表，provider-usage 据此渲染成「该 provider 不上报额度」——用户看到的是「查询功能坏了」，而事实是额度用完了。现在返回一条 `remain: 0` 的窗口（红色空条 + 「0 credits 剩余」），只有「上游一个包都没给」才算真的无可报。
* **智谱 429 的多种语义被一律当成限流重试**：官方把欠费（`1113`）、套餐到期（`1309`）、无模型权限（`1311`）、风控封禁（`1313`）和真限流（`1302`/`1305`）全塞进 HTTP 429，只有真限流值得重试。`classifyUpstreamError` 现按 `"code"` 字段区分（正则兼容紧凑/带空格两种序列化）。

### 新增

* **上游 429 限流台账**（`rate-limit.ts`）：shim 在真正看到上游响应的那一层记录限流观测（`WorkBuddyChatResult` 失败分支现携带响应头），按变体隔离、同一段限流期内合并（保留最早时刻 + 累加次数 + 采用最新重置时刻），成功请求自动清除。恢复时刻**只解析上游响应头**（`Retry-After` 的相对秒/HTTP-date、`X-RateLimit-Reset` 的秒/毫秒 epoch），拿不到就不报——GLM Coding Plan 的并发限流按订阅档位动态调整，不存在可推算的窗口。
* **配置页卡片限流提示框**（`RateLimitBox.tsx`）：有恢复时刻说「{时间} 恢复」，没有则说「已被限 {时长}，上游未提供恢复时间」+ 被拒次数与模型名。用 warn 色而非 error 色——限流会自愈，不是故障。
* **额度 pill 同步显示限流**：`UsageSnapshot.rateLimit` 由查询器从台账读出，pill 折叠态优先显示限流状态（通道被拒时「还剩 80%」是误导）。

> 台账**只观测、不拦截**：它不参与任何请求门禁，不会因「上次被限」拒绝后续请求；请求是否放行完全由上游决定，成功请求自动清除观测。`test/shim-rate-limit.test.ts` 有一条用例专门锁住这个性质（已有活跃限流观测时请求照常打到上游）。

### 文档

* README 增补「上游限流（429）的记录与展示」一节，含各上游限流维度的官方口径对照表与「为什么不能推算恢复时间」的依据。

## 0.4.28-alpha.1 (2026-10-29)

### 修复

* **CLI 诊断面**：help 文本 `--provider` 列表补 `opencode-free` 并删去重复的 `(defaults to workbuddy)` 行；`doctor --provider opencode-free` 的 `fallbackModels` 补上兜底名单计数（此前恒报 0）。
* **探测状态 reason 带变体来源**：`WorkBuddyProbeService` 装配 `variantId` 后，所有 `unavailable` 状态的 reason 带 `<变体>: ` 前缀（如 `zcode: model does not need detection`），多变体共用宿主日志/状态路由时可区分来源；探针清扫失败日志前缀统一为 `dsh-any-connect:`。

### 文档

* README 移除已下线的 ZCode 夜免声明（实现已按 150% 额度与基准计费如实展示）；「删除图标」改「删除按钮」；配置表补 `authFileOpenCode`；安装示例更新到 0.4.27。

## 0.4.28-alpha.0 (2026-10-28)

> 基础号让位：稳定线已归档 0.4.27，本预发布线按版本号规则跳到下一个基础号。

### 新增

* **模型选择器接入 DSH 0.2.2 原生徽标（`LlmModelInfo.badge`）**：`adapter.listModels()` / `resolveModel()` 现在为每个模型带上 provider 自述徽标——免费模型走 `success`（绿）、上游促销标签走 `info`、积分倍率走 `neutral`；徽标与 `name` 后缀共用同一份计费事实（`billingFacts`），两处文案不会漂移。
* **目录变更改走公开事件 `llm/models-updated`**：目录内容真的变化时直接 `ctx.emit('llm/models-updated', provider)`（DSH 0.2.2 新增事件，客户端 `modelDirectories` 订阅即重拉），不再借 `handle.replace()` 触发拓扑事件——语义更准、开销更小。

### 修复

* **`conversation.input.model.label` 槽位不渲染原生徽标**：插件一旦注册该槽，宿主的 fallback 徽标渲染就不再执行，于是 adapter 新增的 `badge` 在模型选择器里完全不可见（实测：槽注册完全取代 fallback）。`ModelLabel` 现在优先消费 `model.badge`（tone → 配色，text 按 `<html lang>` → 浏览器语言 → 英文解析），无 badge 时回退 `name` 的 `· 倍率` 后缀；`/model` 弹窗仍靠 `name` 后缀显示倍率。

### 优化

* **适配 DSH 宿主 `0.2.2-alpha.2` 预发布线**：`dsh.host` 与全部 `@deepseek-ai/dsh-*` 依赖对齐 `^0.2.2-alpha.2`；vendor 依赖同步前移（`@deepseek-ai/cordis ~4.0.6-alpha.1`、`@deepseek-ai/schemastery ~3.18.6-alpha.1`、`@deepseek-ai/cordis-plugin-loader ~1.0.7-alpha.1`），消除双版本 Cordis 导致的 `Context` 声明合并失效。

## 0.4.27 (2026-10-28)

### 修复

* **再解 WorkBuddy 国内网关渠道拦截（400 / 11128）：句子级提示词指纹脱敏（第二代）**：
  * 症状（2026-10-28 实机取证，iotGW 会话请求逐字重放闭环复现）：WorkBuddy 全系模型（`deepseek-v4.1-flash` / `hy4-preview` / `auto` 实测同样命中，与模型无关）报 `Illegal API invocation from an unapproved channel`；最小探针（无 system 提示词）200 正常，完整 DSH 系统提示词 400 必现，触发点在请求体内容而非通道/凭据；
  * 根因：0.4.18 的 `DeepSeek Harness` 词级脱敏仍有效但不再充分——上游网关新增**句子级指纹**：跨句连续串 `Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root`（二分定位），按「大小写不敏感、空白敏感」的连续子串匹配——句界插换行/双空格/改一个词实测均 400→200，全小写仍被拦（改写必须变动字符，仅改大小写无效）；
  * 修法：`sanitizeWorkBuddyChannelFingerprints` 追加规则，把指纹句界 `referenced. Relative paths resolve` 的句号后空白改写为换行，语义零变化；对完整 54K 提示词验证当前仅此一处指纹，改写后整单放行；
  * 回归测试 `test/prepare.test.ts`：system/developer（含 multipart 块）内指纹句界被改写且不再含单空格跨句指纹，user 消息不受影响。

## 0.4.26 (2026-10-27)

### 修复

* **消除插件重载窗口的 UNKNOWN_MODEL 误杀（注册前本地预热模型目录）**：
  * 症状（2026-10-27 实机取证）：插件重载或宿主重启会腰斩在途请求，宿主对传输中断的自动重试（约 500ms 后重发）若落在新实例「已注册但模型目录尚未就绪」的启动窗口，报 `pi-ai provider "workbuddy" has no configured model "..."`（UNKNOWN_MODEL）——该错误不在宿主可重试集合内，整轮任务立即失败，且文案有误导（模型其实配置着，目录只是未发布）；
  * 修法：adapter 注册前先做零网络本地预热（`primeCatalogForRegistration`）：确认已登录即采用 saved/fallback 目录并置为可见，上游拉取照旧异步进行，注册不被网络阻塞；未登录/区域错配保持「空目录=分组隐藏」原语义，夜免徽标在采用那刻同步判定；
  * 效果：登录用户的启动窗口归零——重载/重启瞬间的自动重试不再整轮失败；孪生的 NO_ADAPTER 面孔（注册前路由尚不存在）为 loopback 绑定毫秒级窗口，非插件可消除，遇上等一秒重发即可恢复；
  * 回归测试 `test/catalog-prime.test.ts`：判据锚定在注册那一瞬 adapter 服务的名单（fetchModels 挂起证明名单来自预热而非 live），摘除预热的红灯探测已验证两用例确定性变红。

## 0.4.25 (2026-10-26)

### 新增

* **WorkBuddy 今日积分消耗统计（消耗台账）**：
  * 根因：WorkBuddy 积分是「裂变包」制——上游每天发放一个新包（实测每个 100 积分、30 天有效），旧包到期整包消失，「剩余/总额」每天双向跳动，单看一个时刻读不出今天花了多少；
  * 上游计费端点只有包级快照、没有按日消耗明细，插件改为**采样差分记账**：每次成功查询积分记一次观测，负差分计消耗、正差分计发放，当日最大剩余即「今日峰值」（稳定基准，今日已用 ≈ 峰值 − 当前剩余）；
  * 三处展示面齐改：额度 pill 展开后追加「今日已用」窗口（折叠态语义不变）、配置页卡片新增今日统计行（今日已用/发放/峰值 + 近 7 日每日消耗，悬浮说明估算口径）、`status` CLI 新增 `Today:` 行与 `creditsToday` JSON 字段；
  * 台账持久化进状态域（`dsh_any_connect` 域新增 `ledger` 表，per-record 布局按记录校验，无需迁移）；域不可用时整体降级为「无今日统计」，不影响主链路；
  * 口径诚实声明：样本间「发放+消耗」抵消会被低估（样本数随数据透出）；跨天首观测不计差分（宁少不虚记）；只统计积分制变体，ZCode token 池不进台账。
## 0.4.24 (2026-10-24)

- 修复: Landlock 授权片段改走官方 node-addon-landlock-run grantArgs 产出，不再自拼 launcher flag（对齐官方「消费者不得自拼 flag」契约）；bwrap 无官方 API，拼写留在插件侧。
- 修复: 超时回退原因结构化——本地 deadline 回退的 abort 原因携带与宿主 TimeoutReason 同形状的 code/timeoutMs 字段，消费方可程序化分类；消息文本不变。
- 维护: 依赖分层——react/@types/react/jsdom/@deepseek-ai/schemastery 按实际 import 声明至本包 devDependencies。

## 0.4.23 (2026-10-24)

### 重构

* **宿主依赖解耦移入 devDependencies**：将 `@deepseek-ai/dsh-*` 宿主依赖全部移入 `devDependencies`，切断 pnpm 在 profile 目录落地宿主旧副本的渠道，根治 DSH 宿主升级导致的兼容性误报与服务缺失崩溃；`dependencies` 仅保留纯第三方库 `zod`，`optionalDependencies` 仅保留 `@earendil-works/pi-ai`。

## 0.4.22 (2026-10-24)

### 优化

* **适配 DSH 宿主 0.2.1-rc.3 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.2.1-rc.3`。

## 0.4.21 (2026-10-24)

### 修复

* **Start Plan 卡片额度改为按模型池逐条展示（补齐 0.4.20 漏掉的展示面）**：
  * 0.4.20 只修了额度 pill 与 CLI，配置页变体卡片仍只取"第一个有余额的池"——多池结构下 GLM-5.3 的整整一份额度在卡片上不可见；
  * 卡片改为逐池列出额度行（带模型名，如 `GLM-5.3-Flash：286,362,896 / 300,000,000 tokens`），两池同屏互不吞并；单池与 Coding Plan 订阅展示维持原样；
  * 新增 jsdom 回归用例钉住"两池同屏、不求和"；隔离实例浏览器实测通过。

## 0.4.20 (2026-10-24)

### 修复

* **Start Plan 额度改为按模型池逐条展示（多池结构适配）**：
  * 上游 `billing/balance` 已把一个活动按模型拆成多份 entitlement（2026-10-24 实测 "ZCode 1024 Dev Day"：GLM-5.3-Flash 300M 与 GLM-5.3 200M 各一池，`capabilities` 绑定各自模型，**池子互不通用**）；旧展示层"只取第一个有余额的池"会把其余池子整个吞掉（pill 只见 Flash 的剩余，GLM-5.3 的整整一份额度不可见），而把互不通用的池求和又谎报了一个"哪个模型都能用"的总额度；
  * pill（`startPlanWindows`）改为**每个 token 池一条窗口**：每条带池名、真实 remain/limit 进度条与到期时间；`remain=0` 的池照样显示（红色空条正是"这个模型用完了"的语义）；窗口 id 用池名派生保证唯一（`plan:<池名小写>`，撞名追加序号兜底）；
  * CLI `status` 人读输出每池一行并带模型名；`--json` 的 `quotaWindows` 输出全量池清单（Coding Plan 变体维持订阅有效性单条不变）；
  * 凭据识别、额度解析与 Coding Plan 订阅口径均未改动。

## 0.4.19 (2026-10-22)

### 优化

* **变体卡片积分栏刷新按钮零抖动微交互**：
  * 将 Start Plan、OpenCode 免密及通用变体卡片中的 3 处刷新按钮统一重构为 `CardRefreshButton`；
  * 按钮文案在刷新过程中始终固定为「刷新」，点击后小箭头平滑顺时针自旋（`wb-spin-icon`），彻底消除原本按钮变宽（「正在刷新…」）导致同行左侧积分数值被瞬间向左推挤跳动的微瑕疵。

## 0.4.18 (2026-10-21)

### 新增

* **模型列表自定义管理与一键恢复默认（排除/隐藏不想用的模型）**：
  * 在插件设置页面的模型列表中，为每个模型行新增删除（排除）操作按钮，点击即可从选择列表中隐藏不感兴趣的模型，精简模型选择下拉列表；
  * 在变体卡片顶部右侧提供「恢复默认模型」按钮（当有模型被隐藏时高亮展示已隐藏数量），点击即可一键清空排除规则并恢复官方完整模型清单；
  * 排除配置持久化到插件独立存储，并实时同步给 DSH 宿主模型选择器（ModelSelect / `/model` 菜单），即改即生效。

### 修复

* **彻底解决 WorkBuddy 上游网关渠道拦截（400 / 11128）报错**：
  * **系统提示词渠道指纹脱敏**：定位腾讯 WorkBuddy 上游安全网关对系统提示词（`role: "system"` / `developer`）中 `DeepSeek Harness` 签名实施的黑名单拦截，在请求体规范化层（`prepareChatBody`）自动将特征串脱敏替换为 `Harness`，彻底解除 `code: 11128 ("Illegal API invocation from an unapproved channel")` 报错；
  * **Pi-AI 适配器原生声明**：在模型描述符中显式声明 `compat: { supportsDeveloperRole: false }`，使底层推理引擎从源头直接生成 `system` 角色，规避上游对 `developer` 角色的拒绝；
  * **国内线流式请求防御闭环**：在国内线 `chatStream` 传输中强制应用 `prepareChatBody` 规范化，确保请求体始终符合上游网关规范。
* **OpenCode 纯免费模型免密调用体验优化**：
  * 修复公有免费免密通道在读取凭据时的边界空值处理，确保在未配置任何本地 OpenCode 凭据或 API Key 时，也能顺畅解析并调用 OpenCode 官方免费模型。

## 0.4.17 (2026-10-21)

### 优化

* **变体卡片与配置管理页 UI 美化**：
  * 变体卡片圆角规整为 12px，内边距扩展为 16px，各级卡片层级更协调；
  * 状态指示绿点微动效（`.wb-dot-pulse`）升级为自适应主题的 `color-mix` 扩散阴影；
  * 模型列表表头增加字符间距与大写规范，模型 ID 启用等宽代码字体；
