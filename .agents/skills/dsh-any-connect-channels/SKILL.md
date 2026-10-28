---
name: dsh-any-connect-channels
description: dsh-any-connect 多渠道接入（WorkBuddy 国内/国际、ZCode Coding Plan/Start Plan、OpenCode Free）的事实与排障：凭据与账号选择、各渠道额度语义、zcode-plan 通道风控现状、模型目录刷新与重载窗口、额度展示与积分台账、反编译取证、隔离实例验证。触发：改 dsh-any-connect 的任一渠道（workbuddy / workbuddy-ai / zcode / zcode-start-plan / opencode-free）代码；排查额度或套餐名显示不对；判断 zcode-plan 模型通道能否使用；需要反编译 ZCode / WorkBuddy 客户端或跑插件隔离实测。细节见 references/。
---

# dsh-any-connect × 多渠道接入（WorkBuddy / ZCode / OpenCode Free）

本 skill 覆盖 dsh-any-connect 全部渠道：WorkBuddy（`workbuddy` 国内 / `workbuddy-ai` 国际）、ZCode（`zcode` Coding Plan / `zcode-start-plan` Start Plan）、OpenCode Free（`opencode-free`）。
取证基线：ZCode 桌面 3.14.4（后续实测至 3.16.3）、内置 agent `zcode.cjs` 0.16.9、DSH 0.2.x 各 rc/alpha 线；WorkBuddy 桌面版同机安装。
所有结论均由本机取证得出（当时的一次性复现脚本未入库、现已清理；取证方法与最小探针见
`references/start-plan-channel.md`）。长取证过程、响应样本与排除实验见 `references/`，本文件只留现行结论、判据与最小探针。

## 一、凭据与账号选择

`~/.zcode/v2/credentials.json` 是**扁平的 key→值映射**，真实安装会同时存在多把 key：

```
account-provider:coding-plan:account:bigmodel-team-coding-plan:account:<uid>:api-key
account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:<uid>:api-key
zcodejwttoken                      # 账号计划（Start Plan / off-peak）用它鉴权
oauth:bigmodel:access_token / oauth:active_provider / zcodejwttoken ...
```

- **不要按插入顺序取第一个**：历史实现取"第一个含 `coding-plan` 的条目"，本机实测会取到 **team** 那把，而客户端实际用的是 individual。
- 正确做法：读同目录的 `setting.json`（无密钥，可安全读）——`providerFamilyDomain` 给当前 family，
  `providerFamilyConnectionSelections.<family>.kind` 给计划（`individual-coding-plan` / `team-coding-plan` / `start-plan` / `off-peak`），按 family+kind 精确匹配 key。
- **计划归属以 selection 为准，不是"选中的 key"**：账号计划在凭据里**没有**对应的 api-key 条目，accessToken 只能回落到别的账号的 key；
  把回落的 key 当计划会让额度读到别的账号上去（实测错法）。
- `enc:v1:<iv>.<tag>.<ct>` = AES-256-GCM（base64url 三段），密钥 = SHA-256(`zcode-credential-fallback:<platform>:<homedir>:<username>`)，或 env `ZCODE_CREDENTIAL_SECRET`。
- **计划标识与发请求用的 key 解耦**：`zcodePlan`（客户端 selection）标识账号，`accessToken`（实际 key）用于签名；不要从后者推断前者。

## 二、双计划：Coding Plan 与 Start Plan 是两个产品

两者在插件里是两个独立变体（`zcode` / `zcode-start-plan`），各有模型分组、模型名单、额度池与通道，互不掺用：

| | `zcode`（Coding Plan） | `zcode-start-plan` |
|---|---|---|
| 通道 | 普通通道 `open.bigmodel.cn/api/anthropic` + V4 签名 | 专属通道 `zcode-plan/anthropic` + `zcodejwttoken` + `X-Device-Mid` |
| 额度 | coding-plan 订阅（150% 额度、夜间免费 23:00–09:00） | 一次性、当日有效的 token 包（查 `billing/balance`） |
| 模型名单 | 客户端白名单（再与上游并集） | 活动 entitlements 派生（候选来自 builtinModelIds） |
| 被风控时 | — | **明确报错，绝不静默回落普通通道**（否则额度记到 Coding Plan 头上） |

- 凭据 transform 把客户端的账号计划选择归入 coding 语义：`start-plan`/`off-peak` 选择在 `zcode` 变体一律按 coding 走，不因 selection 改走专属通道。
- 两变体共享同一份桌面凭据文档（各自取用专属材料：api-key vs `zcodejwttoken`+`deviceMid`），但文件、路由、卡片、名单全部互异。
- **夜间免费资格由账号计划决定，不看模型行徽标**：Start Plan = 普通通道 + 150% 额度，**不享受夜间免费**；
  只看徽标会让 start-plan 账号夜间被标成「夜间免费 (生效中)」并把费率改写成 `x0.00`（实测复现）。
  判据：`catalog.setNightFreeEligible(zcodePlan !== 'start-plan')`。

## 三、plan 通道：拦的是请求体指纹（已破解），上游对突发用量另有风控

**这条通道就是官方客户端 Start Plan 的日常通道**：客户端内置 provider 目录（`Contents/Resources/config/provider/zcode-builtin.json` 的
`providerConfigRules.providerRules[]`）明确 `account:bigmodel-start-plan`
（providerName "Start Plan"，access `{type:"zhipu-account", mode:"start-plan"}`，api `anthropic-messages` @
`https://zcode.z.ai/api/v1/zcode-plan/anthropic`）；coding plan（individual/team）同型，baseUrl 是 `https://open.bigmodel.cn/api/anthropic`。

**3012 拦截的判据在 `system` 的形状，不在客户端指纹**：`system` 必须以官方客户端的固定提示词开头——

- 第 0 块恒等 `"You are ZCode, an interactive coding agent"`；
- 第 1 块以官方 agent 提示词（2313 字符）的**前 1211 字符**开头。边界精确：1210 仍 405，1211 通过；
  再长（整块、或前缀后接自有文本）也通过——**是前缀判定，不是全等**。
- 前缀之后可自由追加自己的块：`[身份行][1211 前缀][DSH 自己的 system]` 拿 200，模型按后面的 DSH 身份回答；
  把自有提示词插在官方前缀之前、与官方文本拼进同一块、或整个 system 用字符串形式，仍 405。

实现：`packages/dsh-any-connect/src/zcode-plan-prompt.ts`（常量 + `prepareStartPlanBody`），边界由 `test/zcode-plan-prompt.test.ts` 钉住。

**当前状态（用户 2026-10-25 实机确认）**：上游网关对高额突发消耗账号实施风控，返回
`HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}`。
该账号在 1024 活动期间消耗 1.77 亿 tokens（`used_units: 177937068`）后触发；**官方 ZCode 客户端（3.16.3）同账号实机测试同样确定性报错**，
官方客户端对 3012 无特殊处理（仅对 3007 做阿里云无感验证码重试）。该拦截不消耗额度、与 Coding Plan 完全隔离——此状态下改用 `zcode` 变体。

- 同页多路 relay 不通：`/api/v1/ultra/anthropic`、`/api/v1/ultra-zai/anthropic` 自造 header 返回 `401 code 1002`。
- off-peak：`POST /api/v1/off-peak/ticket`（需 `X-Coding-Plan-Api-Key`）可取票，`/ticket/status` 能到 `ready`；
  但 `POST /api/v1/off-peak/anthropic/v1/messages` 一律 `400 code 3001 parameter error`，参数形状未逆出。
- **已被证伪的变量不要再试**：HTTP 版本、curl/undici、是否 stream、阿里云验证码头与 cookie、浏览器 UA、浏览器内同源 fetch、
  完整 attribution 头集、E2E 客户端签名 V4、`X-Bigmodel-Authorization` 头组、代理与直连两种出口——**只有 system 形状能翻转结果**。
  取证明细与最小探针见 `references/start-plan-channel.md`。

## 四、Start Plan 额度（余额、每日领取、模型名单）

端点用 `zcodejwttoken` + `X-Device-Mid`：

```
GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance[?app_version=<ver>]
    Authorization: Bearer <zcodejwttoken>
    X-Device-Mid: <稳定 UUIDv4>
```

- 返回 `data.plans[]`（活动 `name` / `plan_id` / `ends_at` / `entitlements[]`）与 `data.balances[]`
  （`show_name` / `total_units` / `used_units` / `remaining_units` / `expires_at`，单位是 **token** 不是积分）。
- **一个活动按模型拆多份 entitlement，额度按模型分池**：`capabilities`（`model:<id>`）绑定各自模型，池子互不通用。
  推论：①"取第一个有余额的池"会吞掉其余池子；②把多池求和成"哪个模型都能用"的总额度是错误语义。
  实现：每池一条窗口（`startPlanWindows`，id `plan:<池名小写>`）+ CLI 每池一行 + 配置卡片逐池额度行。
- **额度是每日一次性池子、不结转**：`period: "one_time"`，`used_units` 只增不减；展示要显式声明没用完就作废
  （`WorkBuddyCreditAccount.sameDay`），别显示成可累积余额。`expires_at` 不是"当日"硬规则——按到期时刻是否落在本地今日动态判定。
- **`X-Device-Mid` 是硬要求**：不给 / 每请求随机 → `400 code 3001` 或 `429`。
  取值优先级：`~/.zcode/v2/telemetry-state.json` 的 `deviceMid` → `$DSH_HOME/.dsh-any-connect/zcode-device-mid`
  （自生成并持久化；0.4.x 起文件名无点前缀并移入 state 子目录，旧名 `$DSH_HOME/.zcode-device-mid` 仅作兼容读取、命中时迁移到新路径）。
- 同族端点：`billing/current`、`billing/preview` 可直接读；`billing/claim` 需要阿里云验证码（无码 → `400 code 3007 captcha verify failed`）。

**每日领取只能"探测自动、领取手动"**：`preview` 可纯 HTTP 调用（返回今日可领取清单，今日已领过则空），
`claim` 的 `X-Aliyun-Captcha-Verify-Param` 由渲染进程 `window.AliyunCaptcha` 签发、与浏览器指纹绑定，纯 Node 侧生成不了。
插件实现 `src/zcode-plan-claim.ts`：无 captcha 时**根本不发请求**，直接短路为 `captcha-required`（一等公民状态），绝不伪装成已领取。
判定三态必须分清：探测成功有清单 = `available`；探测成功清单为空 = `none`；**探测失败/超时/401 = `unknown`，绝不塌成 `none`**
（塌成 none 会让用户以为"今天没得领"而白丢一次领取）。

**模型名单按 entitlements 派生，不是内置目录**：`data.plans[].entitlements[].capabilities`（`model:<id>`）才是活动实际放行的模型；
内置目录（builtinModelIds）只是候选——实测活动只授权 GLM-5.3-Flash，另两个返回 `400 code 3006 model not allowed`。
三态纪律（`src/zcode-plan-models.ts`）：

| 状态 | 判据 | 正确返回 |
|---|---|---|
| A 有有效活动且解析出模型 | `ends_at` 秒级 epoch ×1000 ≥ now、`status` active（缺失视为有效） | 该名单 |
| B 查询**成功**但无有效活动（未领取/已过期） | `plans` 过滤后为空 | **空名单**（分组隐藏） |
| C 查询**失败**（HTTP 非 ok / 抛错） | — | `this.models` 兜底 |

- 已确认有有效活动时，名单唯一真源是 entitlements；解析不出模型要返回空，**不许**回退 `this.models`
  （对 start-plan 而言那就是三个幻影模型，回退等于长出"看起来能用、一用就报错"的假名单）。
- 空名单是合法降级信号（空目录 = DSH 隐藏该分组），但**不可持久化**：`refreshCatalog` 必须 `models.length > 0` 才 `catalogStore.save()`。
- 每模型窗口/输出上限以客户端 `config/provider/zcode-builtin.json` 的 `modelConfigRules` 为准（GLM-5.3-Flash 1M/128K、GLM-5.2 1M/128K、GLM-5-Turbo 200K/64K）；
  服务端另有硬上限 `max_tokens ≤ 131072`（131073 → `400 code 1210`）。

## 五、模型目录刷新：拉取链与推送链是两条独立链路

两条链坏起来表现一样（"名单是旧的"），修法完全不同。

### 5.1 拉取链（插件侧定时拉）

- 启动时 `refreshCatalog('startup')`；每 60s `sweep` 做身份核对（身份变了才真拉，稳态零上游请求）；每 60 分钟 `catalogTimer` 全量重拉。
  五个变体（workbuddy / workbuddy-ai / zcode / zcode-start-plan / opencode-free）都接上了这三条（main 源码 runtime.ts：
  `PROVIDER_VARIANTS.map(createRuntime)`，启动 refresh / 60s sweep / 60min timer 三处都遍历全部 runtimes），没有变体被条件跳过。
- **名单真源是客户端白名单，不是上游 `/api/paas/v4/models`**：后者是 BigModel 开放平台目录，对 coding-plan key 返回 11 个 id，
  其中 7 个（glm-4.5 / 4.5-air / 4.6 / 4.7 / 5 / 5.1 / 5.3-flashx）在官方客户端配置里完全没有绑定到 coding-plan。
  现行实现（`zcode-builtin-catalog.ts`）读本机 `zcode-builtin.json`（权威、随客户端发版）→ 白名单为闸门 → 再过滤上游并集与本地保留行；
  白名单不可得（客户端未装 / 不可读 / 结构演进）时回退已注册名单且**不发上游请求**。口径是 `builtinModelIds`（展示面最严）；
  GLM-5.2 / 5-Turbo 只在 rules 里配了参数、不进 builtinModelIds，探针 200 也不展示。要放宽只需并上 rules 绑定的模型 id，一行改动。
  路径口：macOS 标准安装位置 + `ZCODE_BUILTIN_CONFIG` 环境变量覆盖；其余平台未经实测不猜路径，一律降级。
- **saved 目录可能是旧版本写的**：`catalogStore` 存的是上次成功拉取的名单，白名单上线前的 saved 里可能躺着 11 个越界模型；
  saved 先于 live 发布会让人先看到一整屏越界模型，发布 saved 前要用同一份白名单过滤（`filterByCodingPlanWhitelist`）。
- **空名单的恢复延迟**：start-plan 今日未领取 → 空名单 → 分组隐藏；用户领取后最长要等 60 分钟（小时刷新），
  因为 60s sweep 只比对凭据身份、领取不改变身份。上游偶发答空活动清单时（隔离实例 live/empty 而直调同端点有活动 + entitlements 授权），
  sweep 对"目录空 + 领取探测无翻转 + 距上次拉取 ≥5 分钟"再拉一拍（无论结果都前移 `catalogFetchedAtMs`，不会打环），自愈压到分钟级；
  文案改中性表述，不再断言"无活动"。

### 5.2 推送链（选择框实时刷新）

**DSH 0.2.2 起走公开事件 `llm/models-updated(provider)`（2026-10-28 机制更新）**：目录内容真变化时直接
`ctx.emit('llm/models-updated', provider)`——事件声明在 `dsh-llm` 的 `Events` 上，语义就是「该路由的模型或展示元数据变了，
消费者重拉 `listModels()`」；客户端 `ModelCatalogDirectory` 订阅后直接 `refresh()`，且该事件在 `dsh-api-remotes` 的转发白名单里，
Host 一发浏览器就收到（取证见 `catalog-refresh.ts` 的 `notifyCatalogChanged`）。`emit` 只是本地派发、没有可抛点，
客户端没订阅也只会延迟到下一次轮询收敛。

- 宿主 `ModelCatalogDirectory.load()` **命中缓存直接返回**，只在远程事件时重拉：`llm/models-updated`（0.2.2+）/
  `llm/adapters-updated` / `settings/document-updated` / `credentials/record-updated` / `credentials/reference-updated`。
- **只在内容真的变了时通知**：用内容指纹比较（id / name / contextWindow / maxTokens / supportsImages / reasoning / billing），
  **不要用数组引用**——每次刷新都重建整份数组；无条件通知会让所有打开的客户端每小时白重拉白重渲染。
  **空名单也是合法变化**（未领取 → 分组隐藏），必须通知。shim 尚未监听（`adapterHandles` 里没有该 provider）时不补发，
  注册那一次通知会让它可见。

**0.2.1 及更早的宿主线（旧口径）**：当时只能借 `AdapterRegistrationHandle.replace([providerId])` 广播 `llm/adapters-updated`
（拓扑事件、每次真的重注册路由；注册已释放时抛 `LlmError REGISTRATION_DISPOSED`，必须 try/catch）——
完整代码示例与「不吞不会崩进程」的实测见 `references/model-catalog.md`。

### 5.3 重载窗口：UNKNOWN_MODEL / NO_ADAPTER

**症状**：聊天页报 `provider "…" has no configured model "…"`（UNKNOWN_MODEL）或
`no adapter registered for provider "…"`（NO_ADAPTER），跨变体**同一毫秒**出现，几分钟后自愈（或重启后正常）。**不是模型/凭据/数据问题**。

机制链（会话日志逐事件还原）：插件重载 → 旧实例 `shim.close()` 腰斩在途流式请求 → 记 `llm/retry` TRANSPORT terminated
→ 客户端 ~500ms 自动重发 → 重发命中新实例启动窗口（`createRuntime` 故意 `setVisible(false)`，直到异步 `refreshCatalog('startup')`
走完 `store.current()` → `adoptIdentity` 发布 saved 目录；本机实测窗口 ≤0.8s）→ 空目录里 `modelOf()` 找不到模型
→ `UNKNOWN_MODEL` **不在可重试名单** → 重试管线立即放弃。

**判据（指纹）**：跨变体同一毫秒 UNKNOWN_MODEL + 前一拍 `llm/retry` TRANSPORT terminated = 插件级/宿主级重载事件；
单变体、无 retry 前情的 UNKNOWN_MODEL 才去查名单/排除/凭据。上游真下架模型时 UNKNOWN_MODEL 持续且诚实（选择框同步隐藏该行）。
重试落点决定看到哪副面孔：落在新实例 `registerAdapter` 之前（注册要等 `shim.ready`）→ NO_ADAPTER；落在注册后、目录发布前 → UNKNOWN_MODEL。

**现行修法**（`primeCatalogForRegistration`）：saved/fallback 目录的发布（纯本地读：凭据身份 + saved catalog 文件，`current()` 不触网）
挪到 `registerAdapter` **之前 await 完成**，上游 fetchModels 仍注册后异步——登录用户启动窗口归零，重试落窗内也能正常解析模型；
未登录/区域错配保持隐藏。回归测试 `test/catalog-prime.test.ts`。NO_ADAPTER 面孔窗口是 loopback 绑定的毫秒级，遇到等一秒重发即可。
会话日志取证命令（zstd 解压后看 `llm/retry` / `turn/end` / `step/start/end` 时间轴）见 `references/model-catalog.md`。

## 六、额度展示：三处齐改与 pill 的三个坑

- **展示面有三处——额度 pill、配置页变体卡片、CLI——修展示层 bug 必须三处一起排查改齐**：曾只改 pill 与 CLI，
  卡片仍"取第一个有余额的池"，用户在页面上看到 GLM-5.3 的 200M 像不存在，被迫多发一版。
- **Coding Plan 的「5 小时 / 7 天」窗口**来自 `GET https://bigmodel.cn/api/monitor/usage/quota/limit`
  （Bearer 必须是 coding-plan 的 **api-key**；拿 `zcodejwttoken` 会 `401 令牌已过期或验证不正确`）：
  `limits[]` 里 `unit` 3 = 小时 / 6 = 周 / 5 = 月；`TOKENS_LIMIT` 的 `percentage` 是**已用**百分比（报剩余要 `100 - percentage`）；
  `TIME_LIMIT` 给工具调用次数；`nextResetTime` 是**毫秒** epoch（与 `billing/balance` 的秒级 `ends_at` 不同，别搞混）。
  端点不可用或形状不符一律 `undefined` → 查询器回退订阅有效性窗口，**绝不编数字**。响应样本见 `references/quota-and-plan.md`。
- 三个坑：
  1. saved 目录可能是旧版本写的（见 5.1：saved 先于 live 发布 → 用户先看到一整屏越界模型）。
  2. Start Plan 跨天后 `balances` 为空时，pill 若回落到通用的"该 provider 不上报额度"会让人以为额度功能坏了——应如实回「Start Plan: 今日待领取」。
  3. **Plugins 页显示的版本号来自磁盘 package.json，不代表运行中的进程**：`dsh plugin add` 只改磁盘与 node_modules，正在跑的 dsh 仍用启动时加载的旧模块。
     见到旧行为（11 个模型、pill 没有新窗口）先看 `$DSH_HOME/cache/dsh-any-connect/zcode-catalog.json`（2026-10-11 起目录化，历史平铺 `~/.dsh/.zcode-catalog.json` 属旧版布局）：若是旧行为的特征就说明进程没重启；
     **重启必须完全退出 dsh 进程**（刷新浏览器页面不算），`lsof -p <pid>` 可确认进程打开的 DSH_HOME 文件。

## 七、workbuddy-ai（海外版）："凭据能用但 chat 被拒"

**症状**：用户报无法使用 workbuddy.ai 的凭据。典型误判是"凭据没读到"，实测凭据链路完全正常——必须分清"凭据问题"与"chat 授权问题"。

- 凭据、模型目录、账单三条全通：doctor `signed-in`、`/v3/config` 200（25 个模型）、`fetchCredits` 200（total 100）；
  唯独 `chatStream` 返回 **403 `{"code":11140,"msg":"request illegal"}`**（`probeEffort` 同样 403）。同 body 走国内变体 200。
- **11140 = `auth_forbidden`，不是"内容审核"**：提示文案「内容未通过安全审核」是误导性兜底。官方客户端错误码表（反编译）明确
  `[11140,{category:"auth",subcategory:"auth_forbidden"}]`；不要照着提示去改 prompt。
- **判定依据**：官方 WorkBuddy AI 客户端在同一账号、同一网络得到**完全相同**的报错；响应头 `x-user-id` 正确识别账号并主动清 session cookie，
  而同一凭据访问 `/v3/config` 却是 200 ⇒ 不是 token 无效，是服务端按业务/权益规则拒绝 chat。**插件侧无解**（绕过权益等于盗用，不做）。
- 用户侧可做：官方 app 里点截图的 "Use now" 走开通流程 → 查"免费试用待激活" → 拿错误体的 `requestId` 找官方客服。
  插件的替代路径是换其他 provider（自备 API key）。
- **错误文案红线**：宿主 `classifyPiAiError` 用文本正则分类（`/(?:401|403)/` 命中即判 AUTH），`dsh-client-ui-chat` 随后会丢弃我们的
  message 换成固定文案「API 密钥无效」——与密钥无关的 11140 会被显示成密钥失效。修法：状态码渲染为 `HTTP_403`
  （**`HTTP-403` 无效**：`-` 是非词字符，403 两侧仍是 ``），失败文案在 `shim-http.upstreamFailureMessage()` 单一构造点前置如实说明，
  回归锁 `test/shim-failure-copy.test.ts` 断言不触发宿主 7 条分类正则。通用教训：给宿主写错误文案不要裸写状态码数字。
- 完整证据链、排除项与 product.json 权威字段见 `references/workbuddy-ai-and-credits.md`。

## 八、WorkBuddy 积分与消耗台账

**积分是「裂变包」制，这是「总额/剩余天天跳动」的根因**：`get-user-resource` 返回 33 个包（主体系 `CodeBuddy个人版国内运营裂变包`），
上游每天发一个新包（每个 100 积分、`CycleEndTime` = 发放时刻 +30 天，发放时刻每天不同），旧包到期**整包消失**——
总额每天双向跳动（新包 +100、消耗 −N、到期 −整包），单看任何时刻的数字读不出"今天花了多少"。

- **上游没有按日消耗明细**：`get-user-resource` 只有包级快照（`CycleCapacityRemain/Used` 是包整个 30 天生命周期口径，不是今日）。
  消耗统计只能插件侧**采样差分**：每次成功拉到积分记 `{时刻, 剩余}`，负差分计消耗、正差分计发放、当日最大剩余即"今日峰值"
  （今日已用 ≈ 峰值 − 当前剩余）。实现 `src/credit-ledger.ts`。
- **口径必须诚实标注**：①估算——只有 DSH 运行且轮询（pill 60s + 卡片 status 60s）到查询才有样本，两次采样间"发放+消耗"抵消会被低估，样本数随数据透出；
  ②**跨天首观测不计差分**（跨夜窗口的消耗无法归属到哪一天，宁少不虚记）；③只统计积分制变体（kind `workbuddy`），ZCode 的 token 池/订阅不是这个语义，绝不混进台账。
- **展示面三处齐改**（与第六节同一条红线）：pill 追加「今日已用」窗口（折叠态仍只渲染 windows[0] 总计）、
  配置页卡片（`credits.today` / `history`，卡头摘要带「今日已用 N」）、CLI（`Today:` 行 + `creditsToday` JSON 字段）。
- 持久化：`dsh_any_connect` 域新增 `ledger` 表（per-record 布局版本检查，**加表不用 bump version、不用迁移**）；
  域不可用时台账整体缺席，status/pill 降级为「无今日统计」，绝不拖垮读路径（`CreditLedger.record` 契约上从不 reject）。
- 台账 seed 技巧（隔离实例用公开 API 预置样本）与消耗粒度实测见 `references/workbuddy-ai-and-credits.md`。

## 九、宿主线适配与接口审计

`bun run adapt` **只改 `@deepseek-ai/dsh-*` 的 range**，以下三处要手工补（先跑 `adapt --dry-run` 看它打算改什么）：

1. **adapt 会盲目 bump 宿主线已删除的包**（如 `dsh-invariants` 被指到新线不存在的版本 → `bun install` 报
   `No version matching ... (but package exists)`）。判据：`npm view <pkg>@<新线版本> version` 为空即该包不在新线上；
   若本仓从未 import 就删该依赖，不要 pin 一个不存在的版本。
2. **基础包 cordis / schemastery 要跟着一起前移**：不跟着改会解析出**另一份 cordis 实例**，`typecheck` 报
   `Property 'settings' does not exist on type 'Context'`（运行时同样是两个容器）。
   当前 alpha 线（宿主 `0.2.2-alpha.2`）要求 `cordis ~4.0.6-alpha.1`（四包同步）、`schemastery ~3.18.6-alpha.1` 与 `cordis-plugin-loader ~1.0.7-alpha.1`（`dsh-any-connect` 已同步，2026-10-28 实测）；更早的 0.2.1-alpha.1 线是 `cordis ~4.0.5-alpha.1` + `schemastery ~3.18.5-alpha.1`。
   判据：`ls -d node_modules/.bun/@deepseek-ai+cordis@*` 出现多个**不同版本**即重复（同版本多副本是 peer 变体解析，正常）。
3. **版本号形态必须与 `dsh.host` 一致**：alpha 线用 `-alpha.N`（prerelease Release），待命期用纯 semver；发布门禁会校验，待命期发 `-alpha.N` 会被拒绝。

**三处「已评估、有意不采用」，后续审计不要再当缺口报**：
① 直连 fetch 不加 `attributionHeaders()`（模拟官方客户端的 UA 本身就是网关的产品分流契约，加 attribution 会破坏功能；
账号/额度类请求以客户端身份发出，标 harness 身份自相矛盾）；
② 不注册 `registerModelDiscovery`（插件是 profile 自带路由 + 自有目录刷新链路，用户从不填 endpoint，网关也不是标准列模型端点，会落 `DISCOVERY_UNSUPPORTED`）；
③ 各变体配置卡合在一张 `plugins.bundle.config` 卡内，不拆 `plugins.row.config`（两种 slot 都合法，用户拍板保持现形态）。

worktree 里跑 `bun run test:ci` 前必须先 `bun install`（缺 node_modules 会报 `spawnSync .../node_modules/.bin/tsc ENOENT`）；
沙盒下装包要带 `BUN_INSTALL_CACHE_DIR=<repo>/.workwork/bun-cache`。

## 十、隔离实例端到端验证（改插件后必跑）

```bash
H=<workspace>/.workwork/dsh-verify/home
DSH_HOME=$H dsh plugin --profile web add <repo>/packages/dsh-any-connect
DSH_HOME=$H ZCODE_AUTH_FILE=<带指定 selection 的凭据副本> dsh web --port 8932 --no-open
# 两个 ZCode 变体各一条（卡片数据走宿主路由，不必开浏览器即可核对）：
curl -sS "http://127.0.0.1:8932/plugins/dsh-any-connect/zcode/status"    -H "Host: 127.0.0.1:8932"
curl -sS "http://127.0.0.1:8932/plugins/dsh-any-connect/zcode-sp/status" -H "Host: 127.0.0.1:8932"
```

- 验证"客户端选了 start-plan"：把真实 `credentials.json` 复制到临时目录，旁边放一份 `setting.json`
  （`providerFamilyConnectionSelections.bigmodel.kind = start-plan`），用 `ZCODE_AUTH_FILE` 指过去；**不要改用户真实的 `~/.zcode/v2/setting.json`**。
- 浏览器侧用 `~/.local/bin/agent-browser`（全路径，PATH 顺序不保证）。受限会话对该命令申请 `danger-full-access` 提权原生启动
  （wrapper 不注入 `--no-sandbox`、不重定向目录，靠硬失败引导提权）；`SingletonLock: File exists` 时按报错里的实际 profile 路径删 `Singleton*` 再开。
- **变体 id 与路由前缀不同**：注册/查询键是 `zcode-start-plan`，status 路由前缀是 `zcode-sp`；对 provider-usage 的 usage 路由用错键会得到
  `queried: false`，看似注册失败实为查错名字。
- **空名单排查的决定性手法是进程内探针**：status 只给聚合结果（live/empty/fetchedAt），分不清"上游真的没活动"与"那次拉取抽风"——
  在编译产物 `lib/upstream-zcode-start-plan.js` 的 `fetchStartPlanModels` 里临时插 `console.error('[probe] plans=' + ...)` 后重启实例，stderr 直出原始 plans。
  三个坑：①产物缩进是 8 空格 + 分号，按 TS 源码形状 replace 会静默不匹配；②kill 旧实例后 `sleep 2` 可能不够，
  多次"重启后行为没变"其实是 curl 一直打在没死的旧进程上，要轮询端口释放再起；③见上一条变体 id 与路由前缀不同。

**已知测试 flake（与本插件改动无关）**：`usage.test.ts` 偶发 `ENOTEMPTY`——`afterEach` 在 `context.fiber.dispose()` 后立即 `rm(root, {recursive:true})`，
插件异步收尾可能仍在写该目录。判据：单跑该文件 3/3 通过、全量**串行** 5/5 通过、未改动的 pristine main 上两进程并行同样复现
（证明是仓库既有竞态）。遇到先单跑该文件确认，再串行重跑全量，不要为此改业务代码。

## 十一、反编译取证手法（比 grep 全文快得多）

- `app.asar` 有 300+MB，grep 全文会超时；用字节偏移定位（`LC_ALL=C` 避免多字节拖慢）：

```bash
LC_ALL=C grep -abo -E "关键字|X-Off-Peak-Ticket-ID" <bundle> | head -20      # 1) 找偏移
# 2) 按偏移切片（读取固定窗口）后在本地读
node -e "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');const b=Buffer.alloc(4000);fs.readSync(fd,b,0,4000,Number(process.argv[2]));console.log(b.toString('utf8'))" <bundle> <offset>
```

- 两个 bundle 都要查：`Contents/Resources/app.asar`（Electron 主体）与 `Contents/Resources/glm/zcode.cjs`（内置 agent）。
  内置 provider 配置在 `Contents/Resources/config/provider/zcode-builtin.json`（每个 provider 的 `baseUrl` / `access.mode`
  是"端点属于哪条通道"的权威来源）。
- asar 文件表里带 `unpacked:true` 的条目内容不在 asar 里，要去 `app.asar.unpacked/` 同名路径读；
  顺序累加 offset 定位内嵌文件时若把 unpacked 条目的 size 计入，会导致偏移全错。细节与踩坑见 `references/host-adaptation-and-forensics.md`。

## references

- `references/start-plan-channel.md` — plan 通道取证全过程、已排除变量清单、最小探针代码
- `references/quota-and-plan.md` — Start Plan balance / claim 响应样本、Coding Plan 窗口额度 JSON、pill 排查细节
- `references/model-catalog.md` — 拉取/推送链细节、重载窗口取证命令、测试四个坑
- `references/workbuddy-ai-and-credits.md` — 11140 证据链、product.json 权威字段、积分台账实现
- `references/host-adaptation-and-forensics.md` — adapt 缺口细节、asar 取证踩坑
