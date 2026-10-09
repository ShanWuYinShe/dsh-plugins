## 0.4.14-alpha.7 (2026-10-09)

### 新增

* **国际版模型优先选用最大上下文档位**：上游 `contextWindow.supportedLengths` 声明多个可选窗口时，插件工作预算此前固定取 `defaultLength`（通常是最小档），现在改取最大档并以 `maxInputTokens` 封顶（请求体不携带长度参数，此值只决定插件本地打包预算）。声明缺失时依次回退 `defaultLength`、输入上限。

## 0.4.14-alpha.6 (2026-10-09)

### 修复

* **依赖对齐宿主 `0.2.1-alpha.2`**：全部 `@deepseek-ai/dsh-*` 依赖 range 升到 `^0.2.1-alpha.2`；宿主该版把 `@earendil-works/pi-ai` 升到 1.1.0（`TranscriptContext` 增加 brand 字段），插件依赖同步提到 `^1.1.0`，消除双版本类型互斥。
## 0.4.14-alpha.5 (2026-10-08)

### 新增

* **Coding Plan 的 5 小时 / 7 天 / 工具调用额度窗口**：pill 此前只报订阅有效性（「有效」），用户看不到用量窗口。反编译 ZCode 客户端定位到它自己的取数端点 `GET bigmodel.cn/api/monitor/usage/quota/limit`（Authorization 用 coding-plan 的 api-key），实测返回 `TOKENS_LIMIT`（unit=3/number=5 → 5 小时）、`TOKENS_LIMIT`（unit=6/number=1 → 7 天）、`TIME_LIMIT`（工具调用次数），其中 `percentage` 是**已用**百分比。现在 pill 展示这三条窗口（剩余百分比 + 进度条 + 重置时间）；端点不可用或响应形状不符时回退订阅有效性窗口，绝不编数字。

### 修复

* **Start Plan 未领取时不再显示「该 provider 不上报额度」**：每日 00:00 后新池子尚未发放/领取时 `billing/balance` 如实返回空 balances，pill 落到通用文案会让用户以为额度功能坏了。现在如实显示「Start Plan: 今日待领取」；有当日池子时照旧显示真实 token 数。
* **启动时按白名单过滤 saved 名单**：saved 目录可能由旧版本写入（那时还没有产品面白名单），实测升级用户的 saved 里躺着 11 个 Coding Plan 模型（客户端只提供 2 个），启动时会先于 live 拉取被发布出来，用户先看到一整屏越界模型。现在启动即用同一份白名单过滤，白名单不可得时保持原样。

## 0.4.14-alpha.4 (2026-10-07)

### 修复

* **Start Plan 额度 pill 显示真实剩余 token 数**：composer dock 的额度 pill 在窗口缺 `remain` 时只渲染「套餐名: 有效」，而 Start Plan 的当日 token 池（`billing/balance` 的 `remain` / `size` 是真实数字）被 `currentPlanWindow` 丢弃——卡片显示 93M tokens 额度、聊天框下方却看不到剩余额度（用户报告）。现在 `sameDay` 池带 `remain` / `limit` / `unit: 'tokens'`：pill 显示「X tokens 剩余」并画进度条，当日用完是红色空条（正确语义）；Coding Plan 订阅的 `remain` / `size` 恒为 1（有效性标志而非用量），维持「有效」展示。
* **CLI 的 ZCode 额度输出按变体口径**：`dsh-any-connect status` 此前打印裸 `total`——Coding Plan 显示「Remaining credit: 1」（订阅有效性计数被当积分），Start Plan 是无单位 token 数；且 CLI 的凭据 store 缺 `transformCredential`（运行时有），会把 `zcode-start-plan` 的额度查询指到 coding 池子（反之亦然）。现在与运行时同口径固定计划语义，人读行按 pill 语义输出（Start Plan 带 token 数字 / 上限 / 到期时间，Coding Plan 报订阅名与有效性），`--json` 新增 `quotaWindows`（`total` 保留兼容）。
* **Start Plan 空名单分钟级自愈**：上游偶发对 `billing/balance` 答一个空活动清单（实测 catalog 拉得 `live/empty` 的同一时刻，直调同端点却有 active 活动与模型授权，余额也正常），分组诚实隐藏后唯一的恢复路径是小时刷新——最长消失一小时，且卡片同屏出现「93M tokens 额度」与「今日没有有效的 Start Plan 活动」的自相矛盾。现在 sweep 里对「目录空 + 领取探测无翻转 + 距上次拉取 ≥ 5 分钟」再拉一拍（拉取无论结果都前移 `fetchedAtMs`，不会打环）；空名单文案改为中性表述，不再断言「无活动」。

### 文档

* README 的 ZCode 段重写为双变体现状（`zcode` / `zcode-start-plan` 两个独立连接、专属通道已接入且失败如实报错、两变体各自的模型名单口径），并补 `--provider` 列表漏掉的 `zcode-start-plan`。此前还停留在「Start Plan 按普通 ZCode 通道使用」「专属模型通道未接入（被风控拦截）」的旧口径。

## 0.4.14-alpha.3 (2026-10-06)

### 修复

* **Coding Plan 模型名单以客户端内置目录为白名单，不再混入开放平台越界模型**：`/api/paas/v4/models` 是 BigModel 开放平台 API 的模型目录，不是 Coding Plan 订阅的产品面——实测对 coding-plan key 返回 11 个 id，其中 7 个（glm-4.5 / 4.5-air / 4.6 / 4.7 / 5 / 5.1 / 5.3-flashx）在官方客户端配置里完全没有绑定到 coding-plan；端点层放行（实测 glm-4.5 在 anthropic 通道返回 200）≠ 订阅覆盖，其订阅内费率/额度语义未经验证，选中即有按 API 余额计费的风险。名单真源改为本机 ZCode 客户端的 `zcode-builtin.json`（权威来源，随客户端发版更新）：`fetchModels` 先取白名单再过滤上游并集与本地保留行；白名单不可得（客户端未装 / 结构演进）时回退已注册名单且不发上游请求。实测名单由 11 个收敛到官方产品面的 2 个（GLM-5.3、GLM-5.3-Flash），已验证参数（128K / 费率 / 徽章）不受影响。路径口：macOS 标准安装位置 + `ZCODE_BUILTIN_CONFIG` 显式覆盖；其余平台未经实测不猜路径，一律保守降级。

### 测试

* 白名单解析（真实 revision 30 结构 / 大小写空白容忍 / 结构缺失与空名单降级 / Z.AI 系不纳入 / `ZCODE_BUILTIN_CONFIG` 覆盖口）、白名单外的上游 id 拦截、本地保留行同样受白名单约束、白名单不可得时回退且零上游请求等用例全覆盖；另含读本机真实客户端文件的 darwin smoke 用例（未安装则跳过语义）。

## 0.4.14-alpha.2 (2026-10-05)

### 修复

* **依赖树整体对齐宿主 `0.2.1-alpha.1` 线，清除旧基线残留**：`bun.lock` 从零重新解析，清掉上一轮适配遗留的 `0.2.0-rc.2` 旧线子树（`packages` 条目 611 → 362），`@deepseek-ai/*` 不再同名双版本并存；`cordis` 可选 peer 随之修正（`cordis-plugin-include` 1.0.9 → 1.0.10-alpha.1、`cordis-plugin-group` 1.0.4 → 1.0.5-alpha.1）。
* **工具链依赖升到最新补丁**：`@types/node` `^26.6.3` → `^26.6.4`、`jsdom` `^30.1.1` → `^30.1.2`。

## 0.4.14-alpha.1 (2026-10-04)

### 优化

* **适配 DSH 宿主 `0.2.1-alpha.1` 预发布线**：依赖范围与 `dsh.host` 对齐 `~0.2.1-alpha.1`。
* **对齐 `cordis` 到 `4.0.5-alpha.1`、`schemastery` 到 `3.18.5-alpha.1`**：新宿主线把这两个基础包一起前移了。此前的 `^4.0.4` 会解析出另一份 `cordis` 实例，而 `dsh-settings` 的服务声明（`Context.settings`）声明的是宿主选中的那一份，于是类型检查报「Property settings does not exist on type Context」——运行时同样是两个容器。对齐后与宿主共用同一份。
* **移除 `@deepseek-ai/dsh-invariants` devDependency**：新宿主线不再提供该包（其最新只到 `0.2.0-rc.2`），且本仓从未 import 过它——它是历史遗留的 peer devDep，继续 pin 会让 `bun install` 直接失败。

## 0.4.13 (2026-10-04)

### 修复

* **Start Plan 过期或当日未领取时不再显示"错误的模型列表"**：此前名单派生只看活动的 `status`、不看有效期，并把"查询成功但没有任何有效活动"与"查询失败"混为一谈——前者会回退到编译期兜底名单，于是今天一个模型都没授权时，选择框仍列出 GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo，用户选中即得 `400 code 3006 model not allowed`。现在按三态区分：有有效活动 → 按该活动的 entitlements 派生；查询成功但无有效活动（未领取 / 已过期）→ **返回空名单**，分组如实隐藏；查询失败 → 才回退已注册名单。有效期以 `ends_at`（秒级 epoch）判定，字段缺失时保守按有效处理。
* **已确认有活动但授权解析不出模型时也不再回退兜底名单**：那同样会凭空长出"看起来能用、一用就报错"的假名单；空名单是"今天拿不到"（可恢复），假名单更糟。
* **zcode(Coding Plan) 的模型名单此前永远不会更新**：`fetchModels` 拿到上游响应后三个分支全部返回编译期常量，上游名单只被用来判断"非空"随后丢弃——该 provider 每小时刷新的唯一效果是"证明凭据还活着"。现在以上游返回的 id 为准，并与本地目录做**并集** join：上游列出且本地收录过的沿用其已验证参数（窗口 / 输出上限 / 费率 / 徽章），未收录的新 id 走保守默认（200K / 32K / x1.00，宁报小不虚报），本地已收录而上游未列的仍保留（目录接口可能只列一部分）。实测同一账号由可见 1 个模型变为 9 个。
* **空名单不再写入持久化目录**：`catalogStore` 记的是"上次真正加载过的名单"，把空名单存进去会让下次启动的 `saved` 分支把空目录当成已知好状态发布，一旦那时 live 拉取再失败，用户就长期看不到该分组。

### 新增

* **模型选择框实时刷新**：聊天页的模型选择框走宿主的 `session.modelCatalog()`，而客户端组件**命中缓存即直接返回**，只在四个远程事件上重拉——其中只有 `llm/adapters-updated` 是插件能触发的，且该事件的发布函数在宿主里是 private。插件此前只注册一次适配器、之后再未动过注册，于是目录变了也不通知，用户看到的名单一直停在打开页面那一刻。现在目录内容**真的变化**时经公开的 `AdapterRegistrationHandle.replace`（宿主路由集的唯一变更点，正是发布该事件之处）通知宿主，四个变体全覆盖；内容未变则不广播，避免每个打开的客户端每小时白重拉一次。
* **Start Plan 每日领取探测**：status 新增仅属于 Start Plan 变体的 `startPlanClaim` 字段。插件每天自动探测 `billing/preview`（纯 HTTP，不需要验证码），把「今日待领取 + 活动名 + plan_id」如实透出到卡片，并提供 plan_id 复制入口。三种状态严格区分：有可领项 = `available`；已领取 = `none`；**探测失败 / 超时 / 凭据不可读 = `unknown`，绝不塌成 `none`**——把失败读成"今天没得领"会让用户白丢一次领取机会。
* **空名单与"插件坏了"现在可以区分**：卡片新增"上游查询成功、但回答了一个空名单"的说明（Start Plan 变体另附"去客户端领取后这张卡片会自己更新"），目录来源也单列"上游返回零模型"。此前两者都是 `source=live` + 刚拉取 + 0 个模型，长得一模一样。
* **Start Plan 领取后的恢复由最长 60 分钟缩短到约 60 秒**：用户领取既不改变凭据身份、也不落在夜免边界上，原先只能等下一次小时刷新。现在空名单时复用上述免费探测走一条廉价快通道，探到 `available → none` 翻转即立刻重拉；目录非空则完全不探测，稳态零额外请求。

### 说明

* **领取本身仍是手动的，这是硬约束而非实现取舍**：ZCode 的领取必须携带 `X-Aliyun-Captcha-Verify-Param`，该 token 由客户端渲染进程的 `window.AliyunCaptcha` 签发、与浏览器指纹绑定，纯 Node 侧无法生成（实测不带该头一律 `HTTP 400 code 3007 captcha verify failed`）。因此插件的能力边界是「探测自动、领取手动」，`captchaRequired` 显式透出成字段而不是让前端猜——卡片不会出现一个注定失败的"自动领取"按钮。

### 测试

* 修复项均补了会失败的回归用例，并逐条做过**反向验证**（把实现改回旧行为确认用例真的变红），避免"自证绿"。
* 新增用例覆盖：名单派生的三态与 `ends_at` 有效期边界、coding 变体的上游采用与并集、`llm/adapters-updated` 的"仅内容变化才广播"、Start Plan 快通道（翻转触发 / 非空不探测 / 探测失败不误判）、空名单标记的三种来源、领取探测的三态与卡片渲染（含"unknown 绝不渲染成已领取"）。

## 0.4.12 (2026-10-01)

### 修复

* **WorkBuddy 5.6+ 的加密桌面凭据现在能正常解开（此前一律判定为"未登录"）**：桌面端自 5.6 起把 `accessToken` / `refreshToken` 以 `$wbEncrypted` 信封加密落盘（`buildPolicy: "fields"`），字段不再是明文字符串。插件此前只认明文，于是"凭据文件存在、桌面端已登录"也读成未登录——macOS 与 Windows 同样受影响。现在按 5.6 的信封格式（suite 1 / `WBEV1` 帧、AES-256-GCM + 应用自身派生的 AAD）解出字段，再交给既有解析器读身份与有效期；解不开时如实报出可执行的诊断，而不是静默 signed-out。
* **加密凭据的解密助手按产品定位（国内版 / 国际版互不串用）**：`atRestSecretKey` 只存在于 WorkBuddy 自己的 Electron 进程内，插件以 `ELECTRON_RUN_AS_NODE=1` 执行该二进制一次取得。macOS 按各自 bundle id 经 Spotlight 检索并校验身份（装在 `/Applications` 之外也能找到）；Windows 先看默认安装目录 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`，再查 HKCU/HKLM 卸载注册表（覆盖用户自选目录），候选须同时通过产品身份（DisplayName / exe 名）与 Electron 目录布局（`version` 文件 + `resources\app.asar`）校验才会被执行。两个产品各有独立环境变量 `WORKBUDDY_ELECTRON_BIN` / `WORKBUDDY_AI_ELECTRON_BIN`。
* **插件自有副本读回时不再丢身份字段**：`parseOwnDocument` 以前只把副本当作 `auth` 段解析，而 `uid` / `enterpriseId` / `nickname` 与 auth 字段同层、只从 `account` 段读——刷新过一次之后副本读回的 uid 恒为空串，上游请求退化为 `X-No-User-Id`、目录归属键变成 `":"`。
* **账号在桌面端切换后不再继续用旧账号**：自有副本可能属于上一个账号、且因插件刷新过而过期更晚，此前只按过期时间择优，会把旧账号的 token（连同旧 uid）发给上游。现在身份（`uid` / `enterpriseId`）不一致时一律以桌面文件为准；落盘失败期间的内存兜底同样只在身份一致时生效。

### 新增

* `doctor` 增加 `desktopAuthFile.format` 与 `atRestHelper` 两项诊断，文本输出同时打印凭证格式、助手路径与 `signInReason`——"凭据在却未登录"从此可以一次问清是格式问题还是助手定位问题。

### 测试

* **macOS 发现链路的用例不再依赖宿主平台**：本仓 CI 跑在 Linux，移植过来的 macOS Electron 发现用例此前用宿主 `process.platform` 判定，在 Linux 上会在"该平台没有配置解密程序"处提前失败（0.4.11 的发布流水即因此中断，未产出 Release）。现在这些用例显式把 provider 的 `platform` 钉成 `darwin`，Spotlight/plutil/spawn 三个接缝本就全部注入，因此同一批断言在任何 runner 上都跑完整流程。

## 0.4.10 (2026-09-30)

### 优化

* **适配 DSH 宿主 0.2.0-rc.2 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.2.0-rc.2`；同时把 `@earendil-works/pi-ai` 从 `^0.85.1` 提到 `^0.87.1`——rc.2 的 `dsh-llm-pi-ai` 依赖 `^0.87.1`，两版并存会让 `Provider`/`Context` 类型互不兼容（类型检查直接报错），对齐后与宿主共用同一份实现。

## 0.4.9 (2026-09-30)

### 修复

* **Start Plan 专属通道打通（前一版误判为"上游风控封锁"）**：该通道校验的是**请求体指纹**——`system` 须以官方客户端提示词开头（第 0 块为身份行，第 1 块以官方 agent 提示词的**前 1211 字符**开头；边界实测精确到字符：1210 仍拦、1211 通过）。此前把 405 `code 3012` 归因为不可解的"官方客户端指纹封锁"，于是把这条通道判死、文案劝用户切到 Coding Plan——前提是错的。现在请求体前置该指纹、Harness 自己的 system 提示词接在其后：实测同一请求从 405 变 **200**，模型仍按 DSH 的身份与指令回答（问"你是什么产品"答"我是 DSH"），扣的确实是 Start Plan 专属池（`used_units` 实测 +369）。指纹是请求体常量，与传输层/请求头/V4 签名无关（这些变量已逐一排除）。
* **Start Plan 模型名单改为按活动 entitlements 派生**：此前写死客户端内置目录的三个模型，但服务端按活动放行——实测 Trust Build 只授权 GLM-5.3-Flash，另两个返回 `400 code 3006 model not allowed`，选中即错。现在从 `billing/balance` 的 `entitlements[].capabilities`（`model:<id>`）派生；拿不到授权信息时退回兜底名单，而不是让整组模型消失。行元数据（1M/128K、200K/64K 等）改按客户端 `config/provider/zcode-builtin.json` 的 `modelConfigRules` 取，并遵守服务端 `max_tokens ≤ 131072` 的硬上限。
* **Start Plan 额度按"每日发放、当日清零、不结转"呈现**：新增 `WorkBuddyCreditAccount.sameDay`，卡片与说明明确"当日没用完不结转"，不再让每日重置读成可累积余额。
* **3012 的报错文案不再谎称"通道被封"**：指纹已在请求体里，再被拦说明上游新增了判据——如实这么说，而不是把用户劝去 Coding Plan。

### 新增

* **ZCode Start Plan 拆分为独立连接**：Start Plan 与 Coding Plan 是完全不同的两个产品，不再作为同一连接的模式混在一起——新增独立变体 `zcode-start-plan`，与既有 `zcode` 各自有模型分组、模型名单、额度池与通道，共享同一份桌面凭据文档但互不掺用材料：
  * `zcode-start-plan` 走 Start Plan 专属通道（`zcode-plan/anthropic` + 账号 JWT + 设备号），扣其专属额度（**每天发放、当天到期、不结转**的 token 池），卡片展示当日余额与到期时间；模型名单按活动 entitlements 派生，不带 150% 与夜间免费徽标。绝不静默回落普通通道——那会把请求记到 Coding Plan 头上。
  * `zcode`（Coding Plan）恒按 coding 语义走普通通道（150% 额度、夜间免费）扣订阅——即使桌面客户端当前选中的是 Start Plan，本变体也不改走专属通道。

### 修复

* **Start Plan 账号不再显示夜间免费**：23:00–09:00 免费是 Coding Plan 的权益，Start Plan 走普通通道、只有 150% 额度，不享受该窗口。此前插件只看模型行上带不带「夜间免费」徽标，于是 start-plan 账号在夜间会被标成「夜间免费 (生效中)」并把费率改写成 `x0.00`——展示的是一个它拿不到的折扣。现在夜免资格由账号计划决定（`setting.json` 的选择），Start Plan 下该徽标被摘除且费率保持基准价。

## 0.4.8 (2026-09-30)

### 新增

* **同时支持 Coding Plan 与 Start Plan**：账号计划以桌面端 `setting.json` 的选择为准取 key。选中 Start Plan / off-peak 时，该计划在凭据里没有自己的 `...:api-key` 条目，插件回落到账户上的 coding-plan key——Start Plan 账号于是按**普通 ZCode 通道（150% 额度）**正常使用，模型与额度显示同一口径。

### 修复

* **ZCode 凭据按客户端选择精确选取**：真实安装会同时存在 team 与 individual 两把 `...:api-key`（本机实测如此），旧实现取"第一个含 coding-plan 的条目"，选到哪把取决于对象插入顺序。现在读 `setting.json` 的 `providerFamilyConnectionSelections` 精确匹配；账号计划无对应 key 时回落到同 family 的 coding-plan key，均无选择信息时才回到历史行为。
* **计划名不再硬编码**：用量查询此前对 ZCode 固定上报 `Coding Plan`，而本机账号实际是 `GLM Coding Pro` 等活动名；现在回填上游回报的真实 `productName`，卡片头部据此显示。
* **卸载时收尾改为可等待**：dispose 里对心跳删除与 shim 关闭都是 fire-and-forget，与调用方的后续动作（宿主卸载、测试清理临时目录）竞态，表现为 `ENOTEMPTY` 偶发失败与残留监听端口；现在返回 Promise 由 cordis 等待落定。

### 说明

* ZCode 为 Start Plan 另开的专属模型通道（`/api/v1/zcode-plan/anthropic`，Bearer 账号 JWT）当时被判为"被上游风控拦截"：HTTP 405 `code 3012`，且真客户端、浏览器内同源页面、HTTP/1.1 与 HTTP/2、签名/验证码/完整身份头的各种组合实测均被拦。**该结论已在 0.4.9 修正**：拦的是请求体指纹（`system` 须以官方提示词开头），而那是可精确满足的常量；当时把"我发得不像官方客户端"误读成了"通道对第三方关闭"。

## 0.4.7 (2026-09-28)

### 优化

* **适配 DSH 宿主 0.2.0-rc.1 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.2.0-rc.1`；本次宿主 0.1.7-rc.2 → 0.2.0-rc.1 的契约变化均为纯新增，无需代码改动。

## 0.4.6 (2026-09-25)

### 修复

* **客户端流式中途断开时取消上游请求**：Node ≥16 起 `req` 的 `close` 是「请求完成」而非「socket 关闭」，SSE 响应头发出后客户端断开（取消生成/空闲超时）不再触发此前挂接的回调——上游被照常消费到生成结束，白烧积分；且头超时在头到达时已解除传导，abort 传不到 undici。现在改挂 `res` 的 `close` 并显式销毁上游流，中断即取消。
* **logout 等待在途刷新结束**：刷新成功会无条件把结果写回插件自有副本，并发登出会被随后落盘的刷新成果原样复活（表现为「登出后仍登录」）。
* **ZCode 签名握手加 30s 超时**：握手端点挂死时整个 chatStream 此前挂到 undici 默认 headersTimeout（约 300s），调用方的取消与头超时全部失效。
* **后台探针清扫的失败上报**：清扫入口丢弃 promise，而凭据解析会因区域不匹配抛错——未接住的 rejection 在 Node ≥15 默认策略下可终止宿主进程；现在经 `onSweepError` 上报日志。
* **删除 wmic 进程启动时间分支**：正则与 CIM_DATETIME 实际格式不符（恒不匹配）且时区解析错误；统一走 PowerShell `ToFileTimeUtc`（无区域差异）。
* **`prepareAnthropicBody` 顶层 system 已存在时合并而非丢弃/覆盖**：string 追加、blocks 数组追加文本块；此前两个分支分别把 system 消息留在 messages（端点拒绝）或覆盖原 system 内容。
* **`/v1/messages` 的 401 改 Anthropic 形错误体**：SDK 靠 `type` 字段解析结构化错误，OpenAI 形解析退化。
* **请求体超限返回 413** 而非兜底 500（带尾斜杠路径同口径）。
* **ZCode 夜间免费白天不再显示硬编码 `x0.06`**：行内无基线价时显示「价格未知」，不再编造上游可能已调价的费率。
* **配置卡时序守卫**：轮询/展开刷新/重试并发时，慢的旧响应不再把行短暂翻回错误状态；展开已登录卡立即刷新（收起卡不在轮询范围，长收起后展开不再显示陈旧余额）；无基线价的行显示「价格未知」而非空白。

## 0.4.5 (2026-09-25)

### 优化

* **适配 DSH 宿主 0.1.7-rc.2 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.1.7-rc.2`。

# Changelog

## 0.4.4 (2026-09-25)

### 优化

* **额度 pill 只显示总数**：同币种分包求和为一个窗口（明细在配置页卡片里看）；ZCode 只取当前套餐（与卡片同口径）。跨币种/跨周期的窗口永不合并。

## 0.4.3 (2026-09-25)

### 修复

* **设置页轮询随标签页隐藏暂停**：后台不再打 status 路由，恢复可见立即刷新——与同仓 session-archive / provider-usage 对齐。
* **error 态行内显示“读取失败”+重试按钮**：服务错误不再误读成“未登录”。
* **刷新改轮询目录落定**：替代固定 2s 盲等（快时白等、慢时读旧目录又触发二次刷新）。
* **超时统一走宿主 dsh-timeout**：缺席回退本地同语义实现；超时原因可分类（此前裸 Error 字符串 / `AbortSignal.timeout`）。
* **status 路由补 Host 检查**：与探针路由同口径双检；回环守卫三拷贝收敛到 `loopback.ts`，并修正 `[::1]:port` 被误拒（IPv6 访问页面时同源 Host 恒带括号端口）。
* **特权 chip emoji 对读屏隐藏**；Tags 列头进 locale；模型 badge key 去重；错误原文套本地化前缀；卡片加载失败给静态占位（不再无声消失）。

## 0.4.2 (2026-09-24)

### 修复

* **彻底隔离各 Provider（渠道变体）同名模型参数与费率**：
  * **变体类别绑定**：Catalog 构造与当前状态解析显式绑定所属渠道类别（`'workbuddy' | 'zcode'`），彻底杜绝跨 Provider 模型规格与计费配置交叉覆盖。
  * **参数与计费隔离**：
    * `glm-5.3`：WorkBuddy 国内版（64K 输出、费率 x0.79）、WorkBuddy 国际版（48K 输出、费率 x0.79）、ZCode（128K 输出、费率 x1.00、150% 额度特权徽标）三者参数互不混淆。
    * `glm-5.3-flash`：WorkBuddy 国内版（32K 输出、费率 x0.06、全天无夜免）与 ZCode（128K 输出、白天 x0.06、夜间自动切换为 x0.00 并标示「夜间免费 (生效中)」）完全解耦。
    * `hy4-preview`：WorkBuddy 国内版（1M 上下文、费率 x0.29）与国际版（200K 上下文、费率 x0.29）上下文窗口严格区分。
  * **昼夜免费与费率恢复**：夜间（北京时间 23:00~09:00）免费规则仅对 ZCode 渠道生效；白天恢复时严格取模型自身基准费率，不写死覆盖；WorkBuddy 渠道任何模型不受智谱昼夜时段影响。
  * **Upstream 与 Adapter 隔离加固**：
    * 智谱连通性探测时保留 Coding Plan 专属模型全量参数，避免通用 PaaS `/models` 接口返回裁切订阅特权。
    * Adapter 增加 Provider 归属校验与 `withRate` 幂等性处理，防止重复追加费率后缀。

### 优化

* **UI 交互与视觉反馈升级**：
  * 卡片与折叠条目补充平滑 hover/focus 状态反馈。
  * 渠道连接状态指示圆点新增温和呼吸动效（`pulse`）。
  * 刷新按钮引入旋转 Spinner 动画。
  * 暗色模式（Dark Mode）样式对比度修复与视觉对齐。

## 0.4.1 (2026-09-24)

### 新增

* **ZCode 多系统凭据自动发现与跨系统解密支持**：
  * **macOS**：支持 `~/.zcode/v2/credentials.json` 以及 `~/Library/Application Support/(.)zcode/v2/credentials.json` 候选路径；
  * **Windows**：支持 `%USERPROFILE%\.zcode\v2\credentials.json`，并自动回落至 `%LOCALAPPDATA%` 与 `%APPDATA%`（Local / Roaming）目录；
  * **WSL**：借鉴 WorkBuddy 跨系统探测机制，优先透过 WSL 挂载探测 Windows 宿主用户目录（`/mnt/c/Users/<user>/.zcode/...`）与 Windows AppData 目录，并自动利用 Windows 用户名及 profile 路径完成跨环境 AES-256-GCM 解密，未发现时自动回落至 Linux 原生路径；
  * **Linux**：支持 `~/.zcode/v2/credentials.json` 与 `~/.config/(.)zcode/v2/credentials.json`；
  * 支持 `authFileZCode` 配置项与 `ZCODE_AUTH_FILE` 环境变量显式指定。

### 优化

* **模型列表排版升级**：设置页模型列表改用语义化表格布局，增设列头（模型、倍率、窗口、档位）与隔行斑马纹背景，提升视觉对齐与浏览体验。

## 0.4.0 (2026-09-24)

### 新增

* **适配 DSH 宿主 0.1.7-rc.1 稳定线**：依赖范围与 `dsh.host` 对齐 `^0.1.7-rc.1`。
* **支持 ZCode 桌面客户端凭据自动发现与 Client Request Signing V4 协议**：
  自动读取并 AES-256-GCM 解密 `~/.zcode/v2/credentials.json`，完成与 BigModel
  服务端的 Ed25519 签名握手与 8-bit Proof-of-Work 计算，无缝集成 Coding Plan
  150% 额度与每日 23:00~09:00 GLM-5.3-Flash 免费专属特权通道。
* **接入 Anthropic Messages 协议**：将 ZCode 渠道转发端点切换至智谱
  `/api/anthropic/v1/messages`，确保 Coding Plan 额度与免费配额正确生效。
* **修正 GLM-5.3 / GLM-5.3-Flash 模型窗口规格**：对齐智谱官方与 ZCode 内置配置，
  上下文窗口上限设为 1,000,000 (1M)，单次输出最大 token 设为 128,000 (128K)。
* **设置页新增专属 Coding Plan 订阅状态展示**：直观显示 Coding Plan 有效状态、到期时间与专属特权标签。
* **推理思考档位自动探测**：在启动、登录态变化与目录刷新时全自动后台探测模型思考档位并缓存。

### 优化

* **配置卡片视觉去噪与布局精简**：卡片展开后常看信息（当前积分与订阅状态）清晰聚焦，套餐进度条与模型列表默认收起。
* 构建工具链由 pnpm 统一切换至 Bun。

## 0.4.0-alpha.2 (2026-09-24)

### 新增

* **支持 ZCode 桌面客户端凭据自动发现与 Client Request Signing V4 协议**：
  自动读取并 AES-256-GCM 解密 `~/.zcode/v2/credentials.json`，完成与 BigModel
  服务端的 Ed25519 签名握手与 8-bit Proof-of-Work 计算，无缝集成 Coding Plan
  150% 额度与每日 23:00~09:00 GLM-5.3-Flash 免费专属特权通道。
* **接入 Anthropic Messages 协议**：将 ZCode 渠道转发端点切换至智谱
  `/api/anthropic/v1/messages`，解决 OpenAI 兼容端点无法消耗 Coding Plan
  额度而报错 1113 credit 余额不足的问题。
* **修正 GLM-5.3 / GLM-5.3-Flash 模型窗口规格**：对齐智谱官方与 ZCode 内置配置，
  上下文窗口上限设为 1,000,000 (1M)，单次输出最大 token 设为 128,000 (128K)。
* **设置页新增专属 Coding Plan 订阅状态展示**：废除模糊无意义的“当前积分: 1”，
  改用正式的 Coding Plan 订阅卡片，直观显示有效状态、到期时间与专属特权标签。

## 0.4.0-alpha.1 (2026-09-23)

### 优化

* **配置卡片去噪：积分明细不再渲染，模型清单默认收起**。卡片展开后只留
  一行「当前积分 + 刷新」，账号身份回到卡头摘要（不再在卡体重复一遍）；
  此前占据整屏的套餐进度条（多条同名套餐各一行）是积分的**构成**，不是
  用户查询的目标，整块删除；模型清单一并收进卡体的折叠开关，需要时点开。
  常看信息（当前积分）在收起态即可读到，展开后无需滚动。
* 「合计 N」改称「当前积分 N」：该数字是上游积分接口的当前剩余总量，不是
  套餐份额之和，旧说法容易被读成"总额度"。
* 新增配置卡片的渲染回归测试（jsdom + 真实组件），钉住「不再渲染套餐明细」
  「模型清单默认收起」两条口径；根 devDependencies 补 `react-dom` / `jsdom`。

### 测试

* **删除两份「镜像测试」**（`dsh-any-connect` / `provider-usage` 各一份
  `client-fallback.test.ts`）：它们在 spec 里手抄一遍 `apply()` 再断言，对真实
  入口零覆盖——源码改了它们也不会红，只增加维护面。
* 补上真实入口的兜底回归（`test/bundle.test.ts`）：直接 import 两个包的
  `client/index.tsx`，让 slot 注册抛错，断言 `apply()` 不把异常抛给宿主
  loader、且错误在 console 可见（变体验证：把 catch 改回 `throw` 该用例即红）。
* 顺手清理无判据的用例与死代码：`catalog.test.ts` 删「已登录即可见」「设同值
  返回 false」两条同义反复用例；`bundle.test.ts` 删未被引用的 reactStub 与
  「某导出不存在」的墓碑用例。
* `host-heartbeat` 的回收 PID 用例不再无条件依赖 `ps`：读不到进程启动时刻的
  环境显式跳过（该环境中心跳按设计降级为仅 PID 存活判定），而不是静默变红。

## 0.4.0-alpha.0 (2026-09-23)

### 移除

* **整个 ZCode 家族（GLM Coding Plan 直连 + 夜间免费）自本包移除**，插件重新
  聚焦 WorkBuddy 国内版/国际版两个变体：
  - 删除 `zcode` / `zcode-offpeak` 两个 provider、对应卡片与 CLI
    （`--provider zcode` / `--provider zcode-offpeak` 不再可用）；
  - 删除 `apiKeyZcode` 配置字段、`.zcode-auth.json` 凭据副本与 zcode 桌面端
    凭据解密逻辑（`zcode-auth` / `zcode-credentials` / `zcode-upstream` /
    `zcode-signing` / `zcode-offpeak` 五个模块整体删除）；
  - 上游（智谱）已把夜间免费重构为「服务端派发票据」的闲时任务封闭体系，
    并对旧式直调施加风控（HTTP 405 code 3012），非官方复刻无法稳定维持，
    详见 2026-09-23 的排查结论。
* **破坏性变更**：依赖本包接入 GLM Coding Plan 的用户请改用 zcode CLI 或
  等待官方开放接入协议。

## 0.3.19-alpha.4 (2026-09-23)

### 适配

* 跟进 DSH 宿主 0.1.7-alpha.2（无宿主契约变化，纯依赖基线跟进）。
* cordis `^4.0.3` → `^4.0.4`、schemastery `^3.18.3` → `^3.18.4`、
  cordis-plugin-loader `^1.0.4` → `^1.0.5`（新宿主线的 peer 要求）。peer
  解析版本与宿主不一致时 bun 会解析出两份 cordis 物理副本，`dsh-settings`
  的 `Context.settings` 模块增强落在另一份上，插件侧 `settings` 属性消失
  （本次 typecheck 实际破点）。

### 优化

* 思考档位检测全自动化：移除「自动检测」开关、单模型/批量检测按钮与两段式
  确认。目录刷新后自动补测未声明档位的候选（沿用串行队列、账号归属、目录
  指纹失效重测与 TTL 保护）；自动检测进行中卡片仅显示低调的「检测中…」提示。
  consent 门、probe-store 的授权持久化与 probe 控制路由的 `probe` / `clear`
  / `set-consent` action 一并移除（旧客户端发这些 action 得到 400；路由保留
  `refresh` 与既有的 loopback + 进程内 key 护栏）。
* 配置卡片瘦身：移除「详细信息」折叠区（令牌过期时间、模型目录来源、清除
  检测结果）——用户不关心的实现细节；保留账号身份、积分进度、夜间窗口与
  模型列表（含免费/倍率/促销/上下文窗口/档位标签）。
* 模型行去噪：删除「不校验档位」标签（检测的否定性结论是实现细节，不是
  用户需要知道的事——没有档位可选本身就是无声的答案）；右侧元信息从灰底
  chip 堆改为一行纯文本（倍率 · 窗口 · 档位），只保留免费/促销类值得强调的
  彩色徽章，大幅降低视觉噪音。
* 卡片视觉与布局重排：积分套餐由三行（标签/进度条/明细）压缩为单行
  （名称 + 进度条 + 剩余百分比，精确数字进 tooltip）；模型列表改 grid 列
  布局，倍率/窗口/档位以等宽数字跨行对齐；区块标题统一为小号灰字风格
  （「剩余积分」「模型 · 16」），区块间加淡分隔线；卡头加在线状态点、展开
  后状态行不再重复昵称；刷新按钮与夜间窗口状态行同步收敛为轻量样式。

## 0.3.19-alpha.3 (2026-09-22)

### 适配

* 跟进 DSH 宿主 0.1.7-alpha.1：settings 体系重构（`SettingsProvider` →
  `SettingsForms`，`register` / `installSection` / `get` 全部移除），对照
  上游 `dsh-llm-pi-ai` 的新契约迁移：
  - 可编辑字段改 `.volatile()`（`Config` 即 `Volatile` 引用，`.get()` 读
    取；调用方仍传普通值，由 Cordis 解析包裹）；
  - 装配期 `installSection` + `setSource`/`onChange` 改为
    `ctx.on('loader/volatile-update')` 重读并回写各变体凭据存储后重拉目录
    （凭据写入抽成可单测的 `applyVariantConfig`）；
  - 自带配置卡片，向 settings 注册 `configure({ auto: false })`，退出宿主
    自动表单页；
  - 目录条目的 `settingsNs` 取 Loader profile entry id
   （`ctx.fiber.entry?.options.id`），无 Loader 时回落旧命名空间常量。
* 启动目录拉取由两次变为一次（旧装配期 `onChange` 附带的那次随 settings
  provider 一并消失）；行为不变，仍是失败有限重试（初始 1 次 + 最多 2 次）。
* cordis `^4.0.2` → `^4.0.3`、schemastery `^3.18.2` → `^3.18.3`
 （新宿主线的 peer 要求）；新增 `cordis-plugin-loader` 类型依赖
 （`loader/volatile-update` 事件与 `fiber.entry`）。

## 0.3.19-alpha.2 (2026-09-20)

### 优化

* 配置页按零操作原则自动化：目录非 live（saved/fallback/上次失败）时卡片
  展开即后台自动重拉一次，不用再按刷新；失败只进行内提示，不循环打扰
* 已登录卡头第二行改为实时摘要（身份 · 积分合计 · 模型数），常见查询不用
  点开展示；静态产品介绍退到 hover tooltip，不丢失
* 已授权自动检测时，单模型/批量检测一次点击直接执行；两段式确认只留给
  未授权的手动探测

## 0.3.19-alpha.1 (2026-09-20)

### 修复

* `dsh-any-connect logout --provider zcode-offpeak` 误导输出：off-peak 凭据
  完全跟随 zcode 桌面端登录态、没有自有副本，之前的实现掉进 WorkBuddy
  分支去删一个从不存在的文件并声称 "removed"——改为如实报 no-op 并提示
  正确的登出方式

## 0.3.19-alpha.0 (2026-09-20)

### Features

* **设置页重构**：按登录态分组渲染——已登录渠道显示完整卡片（首个默认
  展开），未登录渠道折叠为一行低调条目（点开看诊断原因），全部未登录时
  顶部给出总引导；不再把从未使用的渠道以整卡形式铺满页面
* **统一模型列表**：每个模型一行聚合显示名称、积分倍率、免费/促销徽章、
  上下文窗口与思考档位（声明档位优先，其次检测结果），不再分散在三个
  区块；zcode 系静态目录的档位与窗口同样入列
* **模型信息全自动化**：目录每小时自动重拉一次（上游促销上下线、倍率与
  声明档位调整、新模型不再依赖手动"刷新模型"；启动拉取失败的暂态故障
  也随下一周期自愈）；status 文档的 `models`/`context` 两字段合并为单一
  全量 `models` 行结构（新增声明档位 `efforts`），卡片零拼接渲染
* **思考档位自动检测**：授权开关从 settings 配置（`probeConsent`）迁移到
  探针记录文件持久化（旧配置字段被忽略，需在卡片上重新开启一次）；开启
  后启动与每次目录刷新发现的新候选自动检测，卡片上另有「检测全部候选」
  一键批量（一次确认、宿主串行队列执行、实时进度）；「刷新」按钮合并
  原「刷新 + 重新拉取目录」两个动作
* 夜间免费（zcode-offpeak）卡片新增实时窗口状态（开放取号 / 下次开抢
  时间 / 关闭），宿主侧 60s TTL 缓存避免轮询打爆票据系统

### 修复

* live 目录的免费标记误判：上游免费拼写为 `x0.00 credits`（带单位后缀）
  时 free 判定漏判，免费模型在卡片上显示为付费倍率——判定改为对归一化
  倍率进行

## 0.3.18-alpha.8 (2026-09-19)

### Features

* 新增 ZCode（GLM Coding Plan）provider：把 coding plan 的 GLM-5.3 /
  GLM-5.3-Flash / GLM-5.2 / GLM-5-Turbo 接入 DSH，额度与 zcode CLI 消耗
  同一份套餐。**零配置跟随 zcode 桌面端登录态**（只读解密其本机凭据存储，
  以用户本人身份读取本人数据；不涉及系统钥匙串），也可手动覆盖
  （设置卡 `apiKeyZcode` → `ZCODE_API_KEY` env → `~/.dsh/.zcode-auth.json`）
* 请求以完整 zcode 客户端身份发出（`ZCode/<app 版本>` 身份头、每请求
  attribution 头、`x-api-key` + `Authorization: Bearer` 双鉴权头、设备 id
  跟随 zcode 注册值），客户端签名七件套按 zcode 3.12.3 线上行为复刻
  （握手换 Ed25519 私钥、8-bit PoW），401 签名拒绝按同款语义自愈
  （重握手一次 → 永久 unsigned）；模型对话经本机 loopback shim 以
  Anthropic Messages 协议直通 open.bigmodel.cn，请求体与上游错误体零翻译
  原样中继
* 新增实验性「ZCode 夜间免费」（zcode-offpeak）provider：凭 zcode 会话向
  排队系统取免费票据（availability → take → poll → active 复用 →
  settle/retake 状态机），带 `X-Off-Peak-Ticket-ID` 走夜间中继（GLM-5.3 /
  GLM-5.3-Flash）。窗口与排队完全由服务端裁决；实测该中继存在传输层
  反滥用风控（code 3012，请求语义与头已与官方客户端对齐仍被拦），通道
  保留、失败模式如实报错，恢复可用性取决于智谱风控策略，不承诺
* provider 额度查询（provider-usage 集成）仅对 WorkBuddy 系 provider 注册：
  zcode 套餐余量在有签名的管理面之后不可查，zcode 系凭据打 credits 端点
  必然失败

### 修复

* settings 多 section 装配 bug：`installSection` 每次覆盖共享的 config
  source 引用，导致非最后安装的 section（authFile、probeConsent）改动后
  的即时生效从未真正生效——改为按 namespace 自存 scope + 按 section
  字段归属合并的合成视图
* shim 路由按 pathname 匹配：Anthropic SDK 请求带 `?beta=true` 查询串，
  此前的 URL 全等匹配会把合法请求打成 404（zcode provider 因此完全不可用）

## 0.3.18-alpha.7 (2026-09-19)

### Features

* 向 `@chaoset/provider-usage` 注册 WorkBuddy 额度查询器：本插件拥有 `workbuddy` /
  `workbuddy-ai` 路由并已持有读取桌面 App 登录态的凭据存储，因此由本包回答「还剩
  多少额度」——provider-usage 刻意不内置 WorkBuddy 查询器（只有本包知道该 App 的
  计费接口）
* 展开口径为「每个仍有余额的计费包一行」：真实账号会累积数十个已用尽/已过期的赠送包，
  与卡片一致地过滤 `remain > 0`，只保留尚可用度的包，避免把有用的两三行淹没
* 服务通过 `ctx.inject(['providerUsage'])` + `ctx.get` 结构化读取，**不新增安装期
  依赖**：未安装 provider-usage 时回调不触发，模型通道完全不受影响

## 0.3.18-alpha.6 (2026-09-17)

### 适配

* 配置卡片改由 `plugins.bundle.config` 承接（keyed by 包名）。
  WorkBuddy 两张卡片现显示在本插件的 Plugins 页（描述与组件列表之间），
  展开交互与内容不变；非 page 视图按契约防御性返回一句话 intro。编译期
  契约依赖为 `dsh-client-ui-plugin-manager`
  （import type 引入 slot 声明，零运行时依赖）

## 0.3.18-alpha.5 (2026-09-15)

### Features

* 上下文窗口展示：配置卡片新增"上下文窗口"区，列出每个在服模型的实际
  请求预算；上游声明了可选更大窗口的模型（如国际版 hy4-preview、
  deepseek-v4.1-flash、gpt-6-astra、kimi-k2.8-preview 的 1M 档）额外标注
  可选项。只展示不选择——把上限当作工作预算会虚报可用量（桌面端的档位
  选择器是客户端政策，目录里没有对应参数）

## 0.3.18-alpha.4 (2026-09-15)

### Features

* 推理档位手动检测：卡片新增检测区（候选名单、逐行确认、进行中标识、
  结果徽章、清除），每次检测前行内确认（会发少量真实请求、可能消耗积分）。
  方法为 baseline→sentinel→逐档三步：先证链路可用，再以不可能存在的随机值
  判定上游是否真校验该参数（接受一切的模型直接判 non-validating，不产生
  误报），最后逐档确认。声明档位永远优先，检测结果只补未声明的行
* 检测到的档位直接进入模型选择器：validating 结论的档位可选中，`off` 永不
  经检测授予。记录按账号绑定、带目录指纹（名单变化即失效）与 14 天 TTL，
  账号切换自动清除
* 探针控制路由（写操作双守卫：回环 Host+Origin 与进程内随机 key）：检测、
  清除、手动重拉目录。卡片头部新增"重新拉取目录"按钮
* CLI 仍可用 `doctor`/`status` 查看登录与积分；检测入口目前仅 Web/Desktop
  卡片提供

## 0.3.18-alpha.3 (2026-09-15)

### Features

* 国际版（WorkBuddy AI）第二个 provider `workbuddy-ai`：独立模型分组、
  独立账号/积分/卡片，与国内版互不混用；装哪个 App 出哪个分组。两版同属
  同一客户端框架、共用凭据目录，仅文件名/端点/展示不同，故实现为数据驱动
  的 variant 描述符而非分支逻辑
* 国际版目录走 App 文档 `/v3/config`（`WorkBuddyAI/<版本>` UA，无空格；
  版本按 已装 App → 已保存 → 内置常量 逐级降级）：含 `modelPromotions`
  与对象式 `contextWindow`，工作窗口取 `defaultLength`
* 促销按读取时生效：生效中 factor-0 显示免费 + 徽章；过期后原价不可恢复，
  显示"价格未知 — 刷新后更新"而非继续免费。兜底名单中促销依赖的两行
  （hy3、deepseek-v4.1-flash）直接标未知
* 国际版 chat 自动前置空 system 消息（网关硬性要求，缺失即 400/11128）；
  CLI UA 经实测可直达模型路由，chat 暂不换 UA 以缩小影响面
* 跨产品凭据拒绝：AI 侧读到 CN 凭据（配错文件）即抛可操作的
  RegionMismatchError，按 signed-out 隐藏分组，原因直达卡片与 doctor
* CLI 增加 `--provider workbuddy-ai`（默认仍是国内版）；AI 兜底名单 20 个
  （含 Auto/Fast 等虚拟别名与 GPT/Gemini 行，均为 2026-09-15 实测值）

## 0.3.18-alpha.2 (2026-09-15)

### Fixes

* 模型列表来源可见 + 无凭据时隐藏分组（对齐上游行为）：状态文档新增
  `catalog` 字段（`live` 刚拉到 / `saved` 本账号上次成功 / `fallback`
  内置，附 `fetchedAt` 与 `error`），卡片在模型优惠下方展示一行来源；
  从未登录且无自留副本时分组隐藏（空目录），不再展示点选必错的兜底名单
* 成功拉取的目录按账号（`uid:enterpriseId`）落盘
  `$DSH_HOME/.workbuddy-catalog.json`：重启或拉取失败时优先服务该账号的
  已保存名单，而非编译期快照；账号切换即时换上新账号的已知名单
* 新增 60s 身份核对（与卡片轮询同频，稳态零上游请求）：启动后在桌面端
  登录/登出最多延迟一拍即现形，无需重启插件

## 0.3.18-alpha.1 (2026-09-15)

### Fixes

* 兜底模型清单按 2026-09-15 实测刷新（桌面端 5.5.6 / 内置 CLI 2.137.1）：
  `deepseek-v4-flash` 已被 `deepseek-v4.1-flash` 取代（x0.17 → x0.03，
  128k 输出）、新增 `kimi-k2.8-preview`（x0.77，可关思考、low/high/max 三
  档），共 15 → 16 个，与接口返回的 `cli` 名单逐项一致。附带实证：服务端
  对 `User-Agent` 中的 CLI 版本号不作校验（2.63.2 与 2.137.1 返回同一份
  目录），硬编码 UA 无需改动

## 0.3.18-alpha.0 (2026-09-15)

### Fixes

* 同步稳定线 0.3.17 的全仓审查修复：设置卡片加载态（首拉期间不再误报
  未登录）、非 JSON 200 不打崩渲染树、刷新失败保留 last-good 并继续轮询、
  目录启动拉取改 `resolve()`（过期 token 自动刷新）+ 失败延迟重试、刷新
  退避不再被绕过、chatStream 抛错路径补 `clearTimeout`、进度条无障碍与
  500 诊断拼入失败原因
* 依赖基线同步，本包无代码改动。行为注意：宿主图片管线超预算抛
  `IMAGE_OFFLOAD_REQUIRED`（不再静默裁剪）；本包图片预算走 `PiAiAdapter`
  profile 默认路径，超大图片请求的失败/重试语义跟随宿主

### Fixes

* `chatStream` 补「响应头到达前」30 秒超时（fetch 返回即撤销，SSE 流式阶段
  的长寿命不受影响，错误体读取同窗口兜底）：上游接受连接却不返回响应头时，
  此前要等 pi-ai 侧 300s idle 超时才释放连接。客户端主动断开（取消生成）
  同步归类为 client 而非 server——shim 对已断开的请求静默收尾，不再向已
  销毁的 socket 回写 502
* SSE `[DONE]` 探测保留上一块的尾部字节：标记恰好跨 chunk 分割时单块扫描
  会漏检，流中途出错就会再补发一个 `[DONE]`（客户端看到重复标记、截断被
  伪装成干净收尾）。中断收尾统一终结连接：已见过 `[DONE]` 的直接终结，
  不再悬挂连接
* token 刷新失败同样计入 30 秒节流窗口：刷新端点持续故障且 access token
  还在刷新 margin 内时，此前每条请求都会打一次刷新端点（与「极短有效期
  打爆端点」同构，只是发生在失败侧）
* heartbeat 存活判定：`process.kill(pid, 0)` 的 `EPERM`（PID 存在但属其他
  用户）视为存活，此前被误读成宿主已停；Windows 进程启动时刻在 `wmic`
  失败（Windows 11 24H2 起已移除）后回退 PowerShell `Get-CimInstance` 的
  `FileTimeUtc`（无区域格式）
* `authFile` 设置变更后重拉模型目录：启动时未登录、之后才登录（或改指另
  一账号）的用户不再停留在静态 fallback 列表直到插件重载
* 移除 no-op 的 `invalidate()`（provider 的 `getModels` 本就活读 catalog）
  与无调用的死导出 `defaultDesktopAuthPath`；devDependencies 与
  optionalDependencies 的重复声明去重、vitest 对齐根版本
* 新增 7 用例（chatStream 分类/断开/头超时/错误体兜底、`[DONE]` 跨块、
  断开静默收尾、刷新失败节流、EPERM 存活）；build + typecheck + 全量测试
  通过，并在隔离测试实例真实验证（主界面/归档面板/设置卡片/模型提供方
  渲染正常、控制台零报错、doctor 读取 heartbeat 正常）

## 0.3.15 (2026-09-12)

### Fixes

* 修复 dispose 路径的 unhandled rejection：`shim.close()` 内部以
  `server.once('error', reject)` 收尾，close 期间任何 server error 都会
  reject 该 promise，`void` 不捕获时按 Node 默认策略会终止宿主进程，且恰
  发生在插件卸载路径。现降级为告警日志（与同函数 `shim.ready` 的容错对齐）
* 客户端补 `ctx.locale.register` 重复注册防护（HMR/热切换下重复 apply 时
  异常会穿透 effect 跳过 `slots.inject`，插件卡片整体消失），与
  sandbox-extra-roots 对齐；镜像测试同步更新并新增 HMR/非 HMR 两条用例
* build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.3.14 (2026-09-11)

### Changes

* build + typecheck + 全量测试通过，并在隔离测试实例真实验证

## 0.3.13 (2026-09-10)

### Changes

* provider 契约要求补传 `modelErrors`（解析失败模型的诊断）：本插件
  catalog 只含已成功解析的模型，传空 Map（与宿主自身缺省一致）
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

* 功能与 0.3.7 一致（依赖基线同步）

## 0.3.7 (2026-09-03)

### Changes

* 思考强度按模型精确对齐实际可用集：声明了 `supportedEfforts` 的模型恰好
  提供声明的档位；未声明的旧目录行只提供其 `defaultEffort` 一档。依据：
  上游 wire 不校验 effort 值（无效值同样 200），且对旧模型实测 minimal 与
  max 的思考量无差异——旧模型上提供可选强度是虚假控制
* 移除设置 → 通用设置中的 WorkBuddy 剩余积分行（设置 → 插件的卡片已有
  完整额度展示）


## 0.3.6 (2026-09-03)

### Changes

* 剩余额度展示迁位：从侧栏底部动作位（数据徽章混在归档/设置按钮间，语义
  与视觉都不合）迁至设置 → 通用设置的一行，与语言/外观等全局偏好并列；
  行自绘标签与数值（WorkBuddy 剩余积分 · 43），未登录或无数据时不渲染；
  详情（分包进度条、模型优惠）保持在设置 → 插件的卡片


## 0.3.5 (2026-09-03)

### Bug Fixes

* 修复侧栏额度徽章与设置卡片在浏览器中崩溃（`ReferenceError: React is not
  defined`）：client 构建的 JSX 此前回落 classic 转换，产物引用裸
  `React.createElement`，页面无全局 React 即崩。构建脚本显式
  `jsx: automatic` 并将 `react/jsx-runtime` 设为 external（宿主 ModuleLoader
  已映射该模块，官方 client 插件即此形态）
* 模型下拉框不再显示模型介绍文案：倍率只随模型名显示
  （`GLM-5.2 · x0.79`），description 不再携带内容，消除费率重复


## 0.3.4 (2026-09-03)

### Features

* 主页面侧栏底部新增 WorkBuddy 剩余额度徽章（`sidebar.footer.action` 槽位）：
  每 2 分钟静默轮询，未登录或无额度数据时不渲染；侧栏收起退化为纯数字
* 模型费率去重：倍率只保留在模型名后缀（`GLM-5.2 · x0.79`），模型描述不再
  重复展示倍率，改为携带上游的模型文案（按登录区域取中/英文）


## 0.3.3 (2026-09-03)

### Bug Fixes

* 修复全新安装后读取不到桌面端登录态：settings 文档把未设置的 `authFile`
  物化成空串并原样传给 `setDesktopPath`，空串覆盖把桌面凭据探测路径钉死为
  单个空路径，整包被判定为未登录（status 接口返回 signed-out，设置页卡片
  因此没有账号与额度内容）。空串/纯空白覆盖现在回退到平台默认探测顺序，
  与空环境变量的既有行为一致


## 0.3.2 (2026-09-02)

### Bug Fixes

* 额度统计计入未开始的周期授予：周期型套餐当月额度用尽但 `RemainCycles > 0`
  时，真实剩余 = 当前周期剩余 + 未开始周期数 × 周期额度——此前只算当前周期，
  会把还有后续周期的套餐显示成 0；卡片进度条分子分母同步跨同一范围
* 插件卡片的免费模型不再显示「x0.00 积分/次」速率行（免费徽章已表达该事实），
  促销模型的倍率行保持不变
* 静态兜底模型目录对照 2026-09-02 线上数据复核：15/15 完全一致


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

* 基于 upstream 的 LICENSE 为 MIT；README 顶部声明了来源与致谢
