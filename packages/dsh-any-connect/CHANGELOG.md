# Changelog

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

* 跟进 DSH 宿主 0.1.6-alpha.2：宿主把插件配置从「设置 → 插件配置 tab」
  重构为独立的「插件」（Plugins）页面，配置注册从 `settings.plugin.item`
  （keyed by 设置 namespace）迁移到 `plugins.bundle.config`（keyed by 包名）。
  WorkBuddy 两张卡片现显示在本插件的 Plugins 页（描述与组件列表之间），
  展开交互与内容不变；非 page 视图按契约防御性返回一句话 intro。编译期
  契约依赖随之从 `dsh-client-ui-settings-plugins` 换为
  `dsh-client-ui-plugin-manager`（import type 引入 slot 声明，零运行时依赖）

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
* 跟进 DSH 宿主 0.1.6-alpha.1：仅依赖基线（`dsh.host` → `0.1.6-alpha.1`），
  本包无代码改动——逐符号核对未命中任何宿主破坏性变更（`AssistantProvenance`
  改名、`RequestImageOffloadPolicy` 及 `offloadedImagePrefixCount` /
  `offloadRequestImagesWithPolicy` 删除、`ImageRequestPolicy` →
  `ImageRequestTarget`、`priceImages` 参数收窄），新基线 typecheck 通过。
  行为注意：宿主图片管线改为超预算抛 `IMAGE_OFFLOAD_REQUIRED`（不再静默
  裁剪）；本包图片预算走 `PiAiAdapter` profile 默认路径，超大图片请求的
  失败/重试语义跟随宿主

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

* 跟进 DSH 稳定版 0.1.5-rc.2：全部 `@deepseek-ai/dsh-*` 依赖由 `^0.1.5-rc.1`
  升至 `^0.1.5-rc.2`，`dsh.host` 更新为 `0.1.5-rc.2`（rc.2 与 rc.1 逐包
  对比源码零差异，纯依赖 range 重发，无适配代码改动）
* build + typecheck + 全量测试通过，并在隔离测试实例真实验证

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
