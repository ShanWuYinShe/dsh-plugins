## 0.1.8 (2026-10-19)

### 修复

* **官方 DeepSeek 路由不再显示「不支持额度」**：DSH 0.2.1-rc.2 官方 DeepSeek 的两条路由是
  `deepseek-account`（OAuth 登录）与 `deepseek-official`（API key），而内置查询器此前只认
  `deepseek`——两条官方路由既没有注册，又因 baseURL 只存在于适配器默认值而推断不出查询器，
  pill 只能显示「未提供额度查询」。现三条路由键归一化到同一个 DeepSeek 查询器：配了
  `DEEPSEEK_API_KEY`（或 `llm-deepseek` 段落里的 `apiKeyEnv`）走 `/user/balance`，
  无 key 退到 OAuth 账户钱包（充值 + 赠送，按币种分列）。
* **额度 pill 偶发整页不显示（刷新页面 / 重开插件才恢复）**：browser 半侧在注册 composer dock
  entry 之前同步解析模型目录服务，而宿主 `ctx.get(name)` 在服务提供方 fiber 尚未激活时静默返回
  `undefined`；宿主又把 entry 的 `inject` 结果按「entry × 会话绑定」永久缓存，于是**一次时序不利
  的解析结果会被固化**，该会话整页再也见不到 pill。现改为在
  `ctx.inject(['slots','modelDirectories'])` 子 fiber 内注册 entry：服务就绪才注册，服务重启
  自动重注册（等价于此前手工「重开插件」，但不再需要用户干预）。

## 0.1.7 (2026-10-17)

### 新增与优化

* **适配 DSH 0.2.1-rc.2 正式版（稳定线）**：依赖基线与 `dsh.host` 对齐 `^0.2.1-rc.2`；
* **底栏气泡（Dock Pill）动态刷新微动效**：后台刷新期间状态小圆点启用平滑脉冲呼吸动效（`pu-dot-pulse`），直观呈现数据同步状态；
* **会话与通道状态解析防御性增强**：补齐状态缺失时的边界安全兜底；
* **架构重构**：用量查询层按 provider 解耦重构，消除冗余依赖。

## 0.1.7-alpha.13 (2026-10-16)

### 优化

* **底栏气泡（Dock Pill）动态刷新感知升级**：
  * 在执行后台刷新（`busy === true`）期间，底栏常驻气泡的状态圆点启用柔和的平滑脉冲呼吸微动效（`pu-dot-pulse`），让用户在不展开面板的情况下也能即时感知后台数据请求生命体征。

## 0.1.7-alpha.12 (2026-10-16)

### 优化

* **适配 DSH 宿主 `0.2.1-alpha.5` 预发布线**：依赖范围与 `dsh.host` 对齐 `^0.2.1-alpha.5`。

## 0.1.7-alpha.11 (2026-10-16)

### 修复

* **会话与通道状态解析防御性增强**：补全会话状态或通道标识缺失时的安全兜底，避免异常边界导致额度查询崩溃。

## 0.1.7-alpha.10 (2026-10-16)

### 优化

* **适配 DSH 宿主 `0.2.1-alpha.4` 预发布线**：依赖范围与 `dsh.host` 对齐 `^0.2.1-alpha.4`。

## 0.1.7-alpha.9 (2026-10-15)

### 修复

* **低额度警示条纹流动动画失效修复**：`WindowRow` 在额度剩余 ≤20% 时挂载了 `.pu-stripe` 流动条纹背景，但 `fillStyle` 中返回了内联 CSS 简写属性 `background: color`，在浏览器层会将 `background-image` 重置为 `none`，导致警示斜条纹动画被静默清除。现将内联属性改为具体的 `backgroundColor: color`，确保 `.pu-stripe` 的流动条纹与渐变正常展示。
* **浮动面板视口溢出保护**：将浮动面板的 `maxHeight` 从固定的 `380px` 优化为 `min(380px, calc(100vh - 120px))`，防止矮窗口或高缩放比例下底部内容超出视口。

## 0.1.7-alpha.8 (2026-10-14)

### 优化

* **适配 DSH 宿主 `0.2.1-alpha.3` 预发布线**：依赖范围与 `dsh.host` 对齐 `^0.2.1-alpha.3`。
* **对齐 `cordis` 到 `4.0.5-alpha.2`**：与新宿主线的依赖基线一致，避免两版 `cordis` 并存导致类型不兼容（同 0.1.7-alpha.1 的教训，本轮宿主又前移了一档）。

## 0.1.7-alpha.7 (2026-10-13)

### 修复

* **降级快照标记 `degraded`**：账单端点查询失败但保留了上一轮成功答案时，快照带 `degraded` 标记，面板圆点调暗、headline 追加「数据可能过期」——此前折叠的旧数字顶着绿点冒充新鲜值，过期无从感知。
* **推断无果加负缓存**：未注册且 baseURL 推断不出 querier 的 provider 按 `unresolvedTtlMs`（默认 60s）负缓存，轮询不再每轮白跑一遍 settings/credentials 解析；直接/别名注册查表不受影响，新注册让负缓存让路。

## 0.1.7-alpha.6 (2026-10-13)

### 修复

* **面板「刷新」按钮真刷新**：usage 路由新增 `refresh=1`，手动刷新绕过宿主缓存直接重查账单端点（自动轮询仍走缓存）——此前轮询间隔与缓存 TTL 同为 60s，缓存恒新鲜，按钮永远拿回上一轮轮询的数，修好凭据后也得干等 TTL 过期。
* **失败快照改按 10s 负缓存**：账单端点瞬时故障恢复后，下一次读取即重试，不再陪跑 60s 成功 TTL；失败态对端点的请求频率上界不变。
* **别名路由的缓存失效对齐**：`kimi` 等别名键的缓存随 `moonshot` 注册的热替换/失效一并清除，不再供应已被替换的查询器的答案最多一个 TTL。
* **在途查询与轮询的竞态加固**：querier 热替换后，在途旧查询结算不再把旧答案写回缓存（回写按注册键核对身份）；客户端 `visibilitychange` 先停旧轮询再启新轮询，interval 不再泄漏翻倍。
## 0.1.7-alpha.5 (2026-10-10)

### 变更

* **环回 IP 判定委托宿主**：`route.ts` 的 IP 字面量判定改用宿主 `isLoopbackHost`（127/8 全段、`::1` 及 IPv4-mapped 形态），`localhost` 主机名宿主不认故显式允许；provider-usage 侧不再持有本地 4 词名单。
* **账户契约具名化**：`deepseekAccount` 改为具名消费 + `optionalDependencies` 版本声明 + 真 `AccountClientMetadata` 参数。

### 修复

* **`dsh-agent` 精确钉改回 `^0.2.1-alpha.2`**：精确钉违反 `dsh-baseline` 的 `^<版本>` 形态铁律（该脚本只认 caret 形态，精确版直接 exit 1）。实测改回 `^` 后 branding 冲突未复活（typecheck 绿、全量用例绿），且 `0.2.1-alpha.2` 是 registry 上当前最高的 alpha 版本，无漂移风险。该可选依赖的真实作用是让 `dsh-deepseek-account` 的 `account-tasks.d.ts` 能解析 `@deepseek-ai/dsh-agent` 类型（其声明为 optional peer，无人直接依赖时 bun 不会安装）。

## 0.1.7-alpha.4 (2026-10-09)

### 修复

* **面板打开期间跟随窗口 resize 重判对齐翻转**：此前对齐只在打开瞬间决定，打开后收窄视口会让 320px 面板溢出屏幕右缘。

## 0.1.7-alpha.3 (2026-10-09)

### 修复

* **依赖对齐宿主 `0.2.1-alpha.2`**：全部 `@deepseek-ai/dsh-*` 依赖 range 升到 `^0.2.1-alpha.2`。
## 0.1.7-alpha.2 (2026-10-05)

### 修复

* **依赖树整体对齐宿主 `0.2.1-alpha.1` 线，清除旧基线残留**：`bun.lock` 从零重新解析，清掉上一轮适配遗留的 `0.2.0-rc.2` 旧线子树（`packages` 条目 611 → 362），`@deepseek-ai/*` 不再同名双版本并存；`cordis` 可选 peer 随之修正（`cordis-plugin-include` 1.0.9 → 1.0.10-alpha.1、`cordis-plugin-group` 1.0.4 → 1.0.5-alpha.1）。
* **工具链依赖升到最新补丁**：`@types/node` `^26.6.3` → `^26.6.4`、`jsdom` `^30.1.1` → `^30.1.2`。

## 0.1.7-alpha.1 (2026-10-04)

### 优化

* **适配 DSH 宿主 `0.2.1-alpha.1` 预发布线**：依赖范围与 `dsh.host` 对齐 `~0.2.1-alpha.1`。
* **对齐 `cordis` 到 `4.0.5-alpha.1`**：与新宿主线的依赖基线一致，避免两版 `cordis` 并存导致类型不兼容。

## 0.1.6 (2026-09-29)

### 优化

* **适配 DSH 宿主 0.2.0-rc.2 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.2.0-rc.2`。

## 0.1.5 (2026-09-28)

### 优化

* **适配 DSH 宿主 0.2.0-rc.1 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.2.0-rc.1`；本次宿主 0.1.7-rc.2 → 0.2.0-rc.1 的契约变化均为纯新增，无需代码改动。

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
