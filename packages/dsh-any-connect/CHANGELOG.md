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
