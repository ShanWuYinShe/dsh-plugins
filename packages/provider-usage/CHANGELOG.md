## 0.1.4 (2026-09-25)

### 修复

* **查询超时改为真正生效的 deadline**：此前只 abort 不 race，不响应 abort 的挂死查询器（`register` 是公开扩展点）或挂起的凭据服务会让该 provider 的每次轮询被同一个挂起 Promise 永久拖住；现在 `Promise.race` 保证超时必然结算。
* **软失败的 error 透传到浏览器**：内置查询器用「空 windows + error」表达软失败（端点不可用、无可用余额），转发层此前丢弃 error，浏览器把故障显示成「不上报额度」的绿点；现在透传并过统一脱敏。
* **baseURL 推断回退路径加 deadline**：resolve 阶段（settings/credentials 读取、DeepSeek 无键路径的网络请求）此前无超时保护，挂死的 resolver 会把轮询端点整个拖住。
* **OpenCode 回退路径对默认 baseURL 不再拼出 `/v1/v1` 死链**（必然 404 且盖掉首请求的真实错误）。
* **500 兜底错误文本统一走 registry 导出的 safeMessage**：本地旧副本少一条「token= 查询参数」脱敏规则。
* **配置卡**：手动刷新与 provider 切换并发时，旧请求的乱序响应不再覆盖新 provider 的数据；可选 `remain` 不再被强制按 0 渲染成红色空条。

## 0.1.3 (2026-09-25)

### 修复

* **兼容 DSH 0.1.7-rc.2**：模型目录状态新增必填 `pending` 字段（待选模型），空闲快照补 `null`。
* **适配 DSH 宿主 0.1.7-rc.2 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.1.7-rc.2`。

# Changelog

## 0.1.2 (2026-09-25)

### 新增

* **无 API key 时退到 DeepSeek OAuth 账户钱包**：充值+赠送按币种汇总，pill 渲染口径与接口路径一致；有 key 永远走接口，单源作答不重复计数。
* **面板手动刷新按钮**：不用再干等 60s 轮询。
* **失败保旧值时标“数据可能过期”**：圆点降饱和 + 文案后缀（含 aria-label）。
* **面板右缘自动翻转**：触发按钮靠右时面板右对齐，不溢出视口。
* **面板焦点管理**：打开移焦进面板，Esc 关闭归还触发按钮。

### 修复

* **预警色变量拼写修正**：改用 `--dsw-alias-state-warn-primary`（低额预警恰恰最该跟主题走）。
* **usage 路由补 Host 检查**：与探针路由同口径双检。
* **无障碍**：进度条加 `aria-labelledby` 命名；`subscribe` 方法引用包箭头防 this 丢失；`load` 闭包按目录缓存稳定身份。

## 0.1.1 (2026-09-24)

### 新增

* **支持 OpenCode / OpenCode Go 提供商额度状态查询**：
  * 解析配置提供商凭据与基础路径，支持 OpenCode / OpenCode Go 实时窗口及配额状态展示；
  * 对无公开用量查询端点的渠道提供友好的配置状态说明与引导，避免无响应或空白。

### 优化

* **UI 交互动效与视觉打磨**：
  * 当额度低于 20% 时进度条展示动态斑马条纹背景动效（Stripe Animation），强化告警视觉；
  * 额度数据异步刷新或重新探测时展示平滑加载 Spinner；
  * 进度条元素增加 `role="progressbar"` 与 `aria-valuenow` 等无障碍辅助功能支持；
  * 监听浏览器 `visibilitychange` 事件：当标签页切换至后台时自动挂起轮询，重新聚焦前台时触发恢复刷新，降低无效网络请求。

## 0.1.0 (2026-09-24)

### 新增

* **DSH 插件首个正式版发布**：在聊天输入框底栏即时呈现当前 LLM Provider 的剩余额度。
* **底部额度弹窗交互升级**：支持点击浮层外部任意区域自动收起与 `Escape` 键快捷关闭。
* **主流模型提供商额度查询支持扩充**：
  - 新增 SiliconFlow（硅基流动，`/v1/user/info` 读取可用额度与充值额度）；
  - 新增 BigModel（智谱开放平台，优先查询 Coding Plan 配额，降级读取订阅清单）；
  - 新增 MiniMax（`/v1/token_plan/remains` 支持 5 小时滚动区间与周区间 Token 统计）；
  - 新增 OpenAI / OneAPI / NewAPI（`/dashboard/billing/subscription` 与 `/usage` 自动计算剩余额度）。
* **提供商别名规范化与 BaseURL 域名启发式识别**：支持 `kimi`、`silicon`、`zhipu`、`oneapi` 等别名；对未注册的自定义渠道，自动根据解析出的 `baseURL` 域名匹配对应查询器。
* **UI 交互与视觉优化**：支持平滑缩放滑移动效与背景虚化；额度进度条提供三色阶告警。
* **适配 DSH 宿主 0.1.7-rc.1 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.1.7-rc.1`。

## 0.1.0-alpha.4 (2026-09-24)

### 新增

* **底部额度弹窗支持点击外部自动收起与 Escape 快捷关闭**：监听全局 `pointerdown`
  事件与 `Escape` 键，点击弹窗外任意区域即收起浮层，无需再次点击底部触发 pill。
* **主流模型提供商额度查询支持扩充**：
  - 新增 SiliconFlow（硅基流动，`/v1/user/info` 读取总额度、可用额度与充值额度）；
  - 新增 BigModel（智谱开放平台，优先查询 Coding Plan 配额，降级读取订阅清单）；
  - 新增 MiniMax（`/v1/token_plan/remains` 支持 5 小时滚动区间与周区间 Token 统计）；
  - 新增 OpenAI / OneAPI / NewAPI（`/dashboard/billing/subscription` 与 `/usage`
    自动计算剩余额度或读取 `total_available`）。
* **提供商别名规范化与 BaseURL 域名启发式识别**：支持 `kimi`、`silicon`、`zhipu`、
  `oneapi` 等别名；对未注册的自定义渠道，自动根据解析出的 `baseURL` 域名匹配对应查询器。
* **UI 交互与视觉优化**：展开带有平滑缩放滑移动效与背景虚化；额度进度条提供三色阶
  阶梯告警（充裕为品牌蓝，低于 20% 警告黄，低于 5% 警示红）；适配非数值订阅状态展示。

## 0.1.0-alpha.3 (2026-09-23)

### 适配

* 跟进 DSH 宿主 0.1.7-alpha.2：依赖 range 与 `dsh.host` 同步，无代码改动。
* cordis `^4.0.3` → `^4.0.4`（新宿主线的 peer 要求；peer 解析版本不一致会
  使 `dsh-settings` 的 Context 模块增强失效）。

## 0.1.0-alpha.2 (2026-09-22)

### 适配

* 跟进 DSH 宿主 0.1.7-alpha.1：settings 体系重构（`SettingsProvider.get`
  移除），profile 解析改读 `settings.describe()` 按目录条目 `settingsNs`
  匹配的描述符 `value`；语义不变（目录 + `settingsPath` 仍是唯一事实来源）。
* cordis `^4.0.2` → `^4.0.3`（新宿主线的 peer 要求）。

## 0.1.0-alpha.1 (2026-09-20)

### 优化

* pill 标题多窗口时追加 `+N`（如 `12.5 credits 剩余 +2`），单窗口外观不变；
  其余窗口仍在展开面板里查看

## 0.1.0-alpha.0 (2026-09-19)

### Features

* 新增 `@chaoset/provider-usage`：在对话区底部状态栏（`conversation.composer.dock`）
  显示当前会话 provider 的剩余额度，与宿主自带的轮数/token pill 并列
* **通用查询器注册机制**（宿主没有 provider 额度扩展点，本包自建该 seam）：
  host 半侧导出 `ctx.providerUsage.register(provider, querier, displayName)`，任何
  插件都能为自己的 provider 路由注册额度查询；同 provider 后注册者生效（热重载
  幂等，也允许部署替换内置实现）
* 通用端点/凭据解析：从 DSH 自己的 configurable-provider 目录
  （`llm.listConfigurableProviders()` + settings section）与 `credentials` 服务解析
  `baseURL` / `apiKeyEnv`，查询器无需硬编码 profile 位置
* 内置查询器：DeepSeek（`/user/balance` 按币种）、OpenRouter（key 限额优先，
  回落账户额度）、Moonshot（可用/现金/代金券）
* 同域只读路由 `/plugins/provider-usage/usage`（回环 Origin 守卫、provider 数量上限、
  失败脱敏），60s 缓存、15s 查询超时、并发读取单飞；查询失败保留上次成功数据并标注
* browser 半侧 pill：当前 provider 取自会话模型目录（与 composer 模型选择器同源），
  点击展开各计费包进度条；无查询器显示「未提供额度查询」而非编造数字
